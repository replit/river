import { Static } from '@sinclair/typebox';
import { ServerTransport } from '../transport';
import {
  AnyProcedure,
  PayloadType,
  ProcedureErrorSchemaType,
  OutputReaderErrorSchema,
  InputReaderErrorSchema,
  UNCAUGHT_ERROR_CODE,
} from './procedures';
import {
  AnyService,
  InstantiatedServiceSchemaMap,
  AnyServiceSchemaMap,
} from './services';
import {
  ControlMessagePayloadSchema,
  OpaqueTransportMessage,
  isStreamClose,
  isStreamOpen,
  TransportClientId,
  ControlFlags,
  isStreamCloseRequest,
} from '../transport/message';
import {
  ServiceContext,
  ServiceContextWithState,
  ServiceContextWithTransportInfo,
} from './context';
import { Logger } from '../logging/log';
import { Value } from '@sinclair/typebox/value';
import { Err, Result, Ok } from './result';
import { EventMap } from '../transport/events';
import { Connection } from '../transport/session';
import { coerceErrorString } from '../util/stringify';
import { Span, SpanStatusCode } from '@opentelemetry/api';
import { createHandlerSpan } from '../tracing';
import { ServerHandshakeOptions } from './handshake';
import { ReadStreamImpl, WriteStreamImpl } from './streams';

/**
 * Represents a server with a set of services. Use {@link createServer} to create it.
 * @template Services - The type of services provided by the server.
 */
export interface Server<Services extends AnyServiceSchemaMap> {
  services: InstantiatedServiceSchemaMap<Services>;
  streams: Map<string, ProcStream>;
}

type InputHandlerReturn = Promise<(() => void) | void>;

interface ProcStream {
  id: string;
  serviceName: string;
  procedureName: string;
  inputReader: ReadStreamImpl<
    Static<PayloadType>,
    Static<typeof InputReaderErrorSchema>
  >;
  outputWriter: WriteStreamImpl<
    Result<Static<PayloadType>, Static<ProcedureErrorSchemaType>>
  >;
  inputHandlerPromise: InputHandlerReturn;
}

class RiverServer<Services extends AnyServiceSchemaMap> {
  transport: ServerTransport<Connection>;
  services: InstantiatedServiceSchemaMap<Services>;
  contextMap: Map<AnyService, ServiceContextWithState<object>>;
  // map of streamId to ProcStream
  streamMap: Map<string, ProcStream>;
  // map of client to their open streams by streamId
  clientStreams: Map<TransportClientId, Set<string>>;
  disconnectedSessions: Set<TransportClientId>;

  private log?: Logger;
  constructor(
    transport: ServerTransport<Connection>,
    services: Services,
    handshakeOptions?: ServerHandshakeOptions,
    extendedContext?: Omit<ServiceContext, 'state'>,
  ) {
    const instances: Record<string, AnyService> = {};

    this.services = instances as InstantiatedServiceSchemaMap<Services>;
    this.contextMap = new Map();

    for (const [name, service] of Object.entries(services)) {
      const instance = service.instantiate(extendedContext ?? {});
      instances[name] = instance;

      this.contextMap.set(instance, {
        ...extendedContext,
        state: instance.state,
      });
    }

    if (handshakeOptions) {
      transport.extendHandshake(handshakeOptions);
    }

    this.transport = transport;
    this.disconnectedSessions = new Set();
    this.streamMap = new Map();
    this.clientStreams = new Map();
    this.transport.addEventListener('message', this.onMessage);
    this.transport.addEventListener('sessionStatus', this.onSessionStatus);
    this.log = transport.log;

    this.transport.addEventListener('transportStatus', async ({ status }) => {
      if (status !== 'closed') {
        return;
      }

      this.transport.removeEventListener('message', this.onMessage);
      this.transport.removeEventListener('sessionStatus', this.onSessionStatus);
      await Promise.all([...this.streamMap.keys()].map(this.cleanupStream));
    });
  }

  get streams() {
    return this.streamMap;
  }

  private onMessage = async (message: OpaqueTransportMessage) => {
    if (message.to !== this.transport.clientId) {
      this.log?.info(
        `got msg with destination that isn't this server, ignoring`,
        {
          clientId: this.transport.clientId,
          transportMessage: message,
        },
      );
      return;
    }

    let procStream = this.streamMap.get(message.streamId);
    const isInit = !procStream;

    // create a proc stream if it doesnt exist
    procStream ||= this.createNewProcStream(message);
    if (!procStream) {
      // if we fail to create a proc stream, just abort
      return;
    }

    await this.pushToStream(procStream, message, isInit);
  };

  // cleanup streams on session close
  private onSessionStatus = async (evt: EventMap['sessionStatus']) => {
    if (evt.status !== 'disconnect') return;

    const disconnectedClientId = evt.session.to;
    this.log?.info(
      `got session disconnect from ${disconnectedClientId}, cleaning up streams`,
      evt.session.loggingMetadata,
    );

    const streamsFromThisClient = this.clientStreams.get(disconnectedClientId);
    if (!streamsFromThisClient) return;

    this.disconnectedSessions.add(disconnectedClientId);
    await Promise.all(
      Array.from(streamsFromThisClient).map(this.cleanupStream),
    );
    this.disconnectedSessions.delete(disconnectedClientId);
    this.clientStreams.delete(disconnectedClientId);
  };

  private createNewProcStream(initMessage: OpaqueTransportMessage) {
    if (!isStreamOpen(initMessage.controlFlags)) {
      this.log?.error(
        `can't create a new procedure stream from a message that doesn't have the stream open bit set`,
        {
          clientId: this.transport.clientId,
          transportMessage: initMessage,
          tags: ['invariant-violation'],
        },
      );
      return;
    }

    if (!initMessage.procedureName || !initMessage.serviceName) {
      this.log?.warn(
        `missing procedure or service name in stream open message`,
        {
          clientId: this.transport.clientId,
          transportMessage: initMessage,
        },
      );
      return;
    }

    if (!(initMessage.serviceName in this.services)) {
      this.log?.warn(`couldn't find service ${initMessage.serviceName}`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
      });
      return;
    }

    const service = this.services[initMessage.serviceName];
    if (!(initMessage.procedureName in service.procedures)) {
      this.log?.warn(
        `couldn't find a matching procedure for ${initMessage.serviceName}.${initMessage.procedureName}`,
        {
          clientId: this.transport.clientId,
          transportMessage: initMessage,
        },
      );
      return;
    }

    const session = this.transport.sessions.get(initMessage.from);
    if (!session) {
      this.log?.warn(`couldn't find session for ${initMessage.from}`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
      });
      return;
    }

    const procedure = service.procedures[initMessage.procedureName];

    if (!Value.Check(procedure.init, initMessage.payload)) {
      this.log?.error(`procedure init failed validation`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
      });

      return;
    }

    const maybeCleanup = () => {
      if (!inputReader.isClosed() || !outputWriter.isClosed()) {
        return;
      }

      removeOnCloseListener();
      void this.cleanupStream(initMessage.streamId);
    };

    const inputReader: ProcStream['inputReader'] = new ReadStreamImpl(() => {
      this.transport.sendRequestCloseControl(session.to, initMessage.streamId);
    });
    const removeOnCloseListener = inputReader.onClose(() => {
      maybeCleanup();
    });

    const procClosesWithResponse =
      procedure.type === 'rpc' || procedure.type === 'upload';
    const outputWriter: ProcStream['outputWriter'] = new WriteStreamImpl(
      (response) => {
        this.transport.send(session.to, {
          streamId: initMessage.streamId,
          controlFlags: procClosesWithResponse
            ? ControlFlags.StreamClosedBit
            : 0,
          payload: response,
        });
      },
      () => {
        if (
          !procClosesWithResponse &&
          !this.disconnectedSessions.has(initMessage.from)
        ) {
          // we ended, send a close bit back to the client
          // also, if the client has disconnected, we don't need to send a close
          this.transport.sendCloseControl(session.to, initMessage.streamId);
        }

        maybeCleanup();
      },
    );

    const errorHandler = (err: unknown, span: Span) => {
      const errorMsg = coerceErrorString(err);
      this.log?.error(
        `procedure ${initMessage.serviceName}.${initMessage.procedureName} threw an uncaught error: ${errorMsg}`,
        session.loggingMetadata,
      );

      span.recordException(err instanceof Error ? err : new Error(errorMsg));
      span.setStatus({ code: SpanStatusCode.ERROR });

      if (!outputWriter.isClosed()) {
        outputWriter.write(
          Err({
            code: UNCAUGHT_ERROR_CODE,
            message: errorMsg,
          } satisfies Static<typeof OutputReaderErrorSchema>),
        );
        outputWriter.close();
      }
    };

    const sessionMeta = this.transport.sessionHandshakeMetadata.get(session);
    if (!sessionMeta) {
      this.log?.error(`session doesn't have handshake metadata`, {
        ...session.loggingMetadata,
        tags: ['invariant-violation'],
      });
      return;
    }

    // pump incoming message stream -> handler -> outgoing message stream
    let inputHandlerPromise: InputHandlerReturn;
    const serviceContextWithTransportInfo: ServiceContextWithTransportInfo<object> =
      {
        ...this.getContext(service, initMessage.serviceName),
        to: initMessage.to,
        from: initMessage.from,
        streamId: initMessage.streamId,
        session,
        metadata: sessionMeta,
      };

    switch (procedure.type) {
      case 'rpc':
        inputHandlerPromise = createHandlerSpan(
          procedure.type,
          initMessage,
          async (span): InputHandlerReturn => {
            try {
              const outputMessage = await procedure.handler(
                serviceContextWithTransportInfo,
                initMessage.payload,
              );

              if (outputWriter.isClosed()) {
                // A disconnect happened
                return;
              }

              outputWriter.write(outputMessage);
              outputWriter.close();
            } catch (err) {
              errorHandler(err, span);
            } finally {
              span.end();
            }
          },
        );
        break;
      case 'stream':
        inputHandlerPromise = createHandlerSpan(
          procedure.type,
          initMessage,
          async (span): InputHandlerReturn => {
            try {
              const dispose = await procedure.handler(
                serviceContextWithTransportInfo,
                initMessage.payload,
                inputReader,
                outputWriter,
              );

              return dispose;
            } catch (err) {
              errorHandler(err, span);
            } finally {
              span.end();
            }
          },
        );

        break;
      case 'subscription':
        inputHandlerPromise = createHandlerSpan(
          procedure.type,
          initMessage,
          async (span): InputHandlerReturn => {
            try {
              const dispose = await procedure.handler(
                serviceContextWithTransportInfo,
                initMessage.payload,
                outputWriter,
              );

              return dispose;
            } catch (err) {
              errorHandler(err, span);
            } finally {
              span.end();
            }
          },
        );
        break;
      case 'upload':
        inputHandlerPromise = createHandlerSpan(
          procedure.type,
          initMessage,
          async (span): InputHandlerReturn => {
            try {
              const outputMessage = await procedure.handler(
                serviceContextWithTransportInfo,
                initMessage.payload,
                inputReader,
              );

              if (outputWriter.isClosed()) {
                // A disconnect happened
                return;
              }
              outputWriter.write(outputMessage);
              outputWriter.close();
            } catch (err) {
              errorHandler(err, span);
            } finally {
              span.end();
            }
          },
        );

        break;
      default:
        // procedure is inferred to be never here as this is not a valid procedure type
        // we cast just to this.log
        this.log?.warn(
          `got request for invalid procedure type ${
            (procedure as AnyProcedure).type
          } at ${initMessage.serviceName}.${initMessage.procedureName}`,
          { ...session.loggingMetadata, transportMessage: initMessage },
        );
        return;
    }

    const procStream: ProcStream = {
      id: initMessage.streamId,
      inputReader: inputReader,
      outputWriter: outputWriter,
      serviceName: initMessage.serviceName,
      procedureName: initMessage.procedureName,
      inputHandlerPromise,
    };

    this.streamMap.set(initMessage.streamId, procStream);

    // add this stream to ones from that client so we can clean it up in the case of a disconnect without close
    const streamsFromThisClient =
      this.clientStreams.get(initMessage.from) ?? new Set();
    streamsFromThisClient.add(initMessage.streamId);
    this.clientStreams.set(initMessage.from, streamsFromThisClient);

    return procStream;
  }

  private async pushToStream(
    procStream: ProcStream,
    message: OpaqueTransportMessage,
    isInit?: boolean,
  ) {
    const { serviceName, procedureName } = procStream;
    const procedure = this.services[serviceName].procedures[procedureName];

    // Init message is consumed during stream instantiation
    if (!isInit) {
      if (
        'input' in procedure &&
        Value.Check(procedure.input, message.payload)
      ) {
        procStream.inputReader.pushValue(Ok(message.payload));
      } else if (!Value.Check(ControlMessagePayloadSchema, message.payload)) {
        // whelp we got a message that isn't a control message and doesn't match the procedure input
        // so definitely not a valid payload
        this.log?.error(
          `procedure ${serviceName}.${procedureName} received invalid payload`,
          {
            clientId: this.transport.clientId,
            transportMessage: message,
            validationErrors: [
              ...Value.Errors(procedure.init, message.payload),
            ],
          },
        );
      }
    }

    if (isStreamClose(message.controlFlags)) {
      procStream.inputReader.triggerClose();
    }

    if (isStreamCloseRequest(message.controlFlags)) {
      procStream.outputWriter.triggerCloseRequest();
    }
  }

  private getContext(service: AnyService, serviceName: string) {
    const context = this.contextMap.get(service);
    if (!context) {
      const err = `no context found for ${serviceName}`;
      this.log?.error(err, {
        clientId: this.transport.clientId,
        tags: ['invariant-violation'],
      });
      throw new Error(err);
    }

    return context;
  }

  private cleanupStream = async (id: string) => {
    const stream = this.streamMap.get(id);
    if (!stream) {
      return;
    }

    // end the streams and wait for the handlers to finish
    if (!stream.inputReader.isClosed()) {
      // Drain will make sure any read leads to an error instead of looking like
      // the stream cleanly closed.
      stream.inputReader.drain();
      stream.inputReader.triggerClose();
    }
    // We wait for the handler because we want to ensure that we have all the disposables
    void stream.inputHandlerPromise.then((maybeDispose) => {
      maybeDispose?.();
    });

    if (!stream.outputWriter.isClosed()) {
      stream.outputWriter.close();
    }
    this.streamMap.delete(id);
  };
}

/**
 * Creates a server instance that listens for incoming messages from a transport and routes them to the appropriate service and procedure.
 * The server tracks the state of each service along with open streams and the extended context object.
 * @param transport - The transport to listen to.
 * @param services - An object containing all the services to be registered on the server.
 * @param handshakeOptions - An optional object containing additional handshake options to be passed to the transport.
 * @param extendedContext - An optional object containing additional context to be passed to all services.
 * @returns A promise that resolves to a server instance with the registered services.
 */
export function createServer<Services extends AnyServiceSchemaMap>(
  transport: ServerTransport<Connection>,
  services: Services,
  providedServerOptions?: Partial<{
    handshakeOptions?: ServerHandshakeOptions;
    extendedContext?: Omit<ServiceContext, 'state'>;
  }>,
): Server<Services> {
  return new RiverServer(
    transport,
    services,
    providedServerOptions?.handshakeOptions,
    providedServerOptions?.extendedContext,
  );
}
