import { Static } from '@sinclair/typebox';
import { ServerTransport } from '../transport';
import {
  PayloadType,
  ProcedureErrorSchemaType,
  OutputReaderErrorSchema,
  InputReaderErrorSchema,
  UNCAUGHT_ERROR_CODE,
  UNEXPECTED_DISCONNECT_CODE,
  AnyProcedure,
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
  /**
   * Services defined for this server.
   */
  services: InstantiatedServiceSchemaMap<Services>;
  /**
   * A set of stream ids that are currently open.
   */
  openStreams: Set<string>;
}

type InputHandlerReturn = Promise<(() => void) | void>;

class RiverServer<Services extends AnyServiceSchemaMap>
  implements Server<Services>
{
  private transport: ServerTransport<Connection>;
  private contextMap: Map<AnyService, ServiceContextWithState<object>>;
  private log?: Logger;

  public openStreams: Set<string>;
  public services: InstantiatedServiceSchemaMap<Services>;

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
    this.openStreams = new Set();
    this.log = transport.log;

    const handleMessage = (msg: EventMap['message']) => {
      if (msg.to !== this.transport.clientId) {
        this.log?.info(
          `got msg with destination that isn't this server, ignoring`,
          {
            clientId: this.transport.clientId,
            transportMessage: msg,
          },
        );
        return;
      }

      if (this.openStreams.has(msg.streamId)) {
        return;
      }

      this.createNewProcStream(msg);
    };
    this.transport.addEventListener('message', handleMessage);

    const handleSessionStatus = (evt: EventMap['sessionStatus']) => {
      if (evt.status !== 'disconnect') return;

      const disconnectedClientId = evt.session.to;
      this.log?.info(
        `got session disconnect from ${disconnectedClientId}, cleaning up streams`,
        evt.session.loggingMetadata,
      );
    };
    this.transport.addEventListener('sessionStatus', handleSessionStatus);

    this.transport.addEventListener('transportStatus', (evt) => {
      if (evt.status !== 'closed') return;

      this.transport.removeEventListener('message', handleMessage);
      this.transport.removeEventListener('sessionStatus', handleSessionStatus);
    });
  }

  private createNewProcStream(initMessage: OpaqueTransportMessage) {
    const {
      streamId,
      procedureName,
      serviceName,
      controlFlags,
      payload: initPayload,
      from,
    } = initMessage;

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

    if (!procedureName || !serviceName) {
      this.log?.warn(
        `missing procedure or service name in stream open message`,
        {
          clientId: this.transport.clientId,
          transportMessage: initMessage,
        },
      );
      return;
    }

    if (!(serviceName in this.services)) {
      this.log?.warn(`couldn't find service ${serviceName}`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
      });
      return;
    }

    const service = this.services[serviceName];
    if (!(procedureName in service.procedures)) {
      this.log?.warn(
        `couldn't find a matching procedure for ${serviceName}.${procedureName}`,
        {
          clientId: this.transport.clientId,
          transportMessage: initMessage,
        },
      );
      return;
    }

    const session = this.transport.sessions.get(from);
    if (!session) {
      this.log?.warn(`couldn't find session for ${from}`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
      });
      return;
    }

    const procedure = service.procedures[procedureName];

    if (!Value.Check(procedure.init, initPayload)) {
      this.log?.error(`procedure init failed validation`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
      });

      return;
    }

    let didSessionDisconnect = false;
    const onSessionStatus = (evt: EventMap['sessionStatus']) => {
      if (evt.status !== 'disconnect') {
        return;
      }

      if (evt.session.to !== from) {
        return;
      }

      didSessionDisconnect = true;

      if (!inputReader.isClosed()) {
        inputReader.pushValue(
          Err({
            code: UNEXPECTED_DISCONNECT_CODE,
            message: `client unexpectedly disconnected`,
          }),
        );
        inputReader.triggerClose();
      }

      outputWriter.close();
    };
    this.transport.addEventListener('sessionStatus', onSessionStatus);

    const onMessage = (msg: OpaqueTransportMessage) => {
      if (streamId !== msg.streamId) {
        return;
      }

      if (msg.from !== from) {
        this.log?.error('Got stream message from unexpected client', {
          clientId: this.transport.clientId,
          transportMessage: msg,
        });

        return;
      }

      if (isStreamCloseRequest(msg.controlFlags)) {
        outputWriter.triggerCloseRequest();
      }

      if (inputReader.isClosed()) {
        this.log?.error('Received message after input stream is closed', {
          clientId: this.transport.clientId,
          transportMessage: msg,
        });

        return;
      }

      if ('input' in procedure && Value.Check(procedure.input, msg.payload)) {
        inputReader.pushValue(Ok(msg.payload));
      } else if (!Value.Check(ControlMessagePayloadSchema, msg.payload)) {
        this.log?.error(
          `procedure ${serviceName}.${procedureName} received invalid payload`,
          {
            clientId: this.transport.clientId,
            transportMessage: msg,
          },
        );
      }

      if (isStreamClose(msg.controlFlags)) {
        inputReader.triggerClose();
      }
    };
    this.transport.addEventListener('message', onMessage);

    let procDispose: void | (() => void) = undefined;
    const cleanup = () => {
      this.transport.removeEventListener('message', onMessage);
      this.transport.removeEventListener('sessionStatus', onSessionStatus);
      this.openStreams.delete(streamId);

      if (procDispose) {
        procDispose();
      }
    };

    const inputReader = new ReadStreamImpl<
      Static<PayloadType>,
      Static<typeof InputReaderErrorSchema>
    >(() => {
      this.transport.sendRequestCloseControl(session.to, initMessage.streamId);
    });
    inputReader.onClose(() => {
      if (outputWriter.isClosed()) {
        cleanup();
      }
    });

    const procClosesWithResponse =
      procedure.type === 'rpc' || procedure.type === 'upload';
    const outputWriter = new WriteStreamImpl<
      Result<Static<PayloadType>, Static<ProcedureErrorSchemaType>>
    >(
      (response) => {
        this.transport.send(session.to, {
          streamId,
          controlFlags: procClosesWithResponse
            ? ControlFlags.StreamClosedBit
            : 0,
          payload: response,
        });
      },
      () => {
        if (!procClosesWithResponse && !didSessionDisconnect) {
          // we ended, send a close bit back to the client
          // also, if the client has disconnected, we don't need to send a close
          this.transport.sendCloseControl(session.to, streamId);
        }

        if (inputReader.isClosed()) {
          cleanup();
        }
      },
    );

    const errorHandler = (err: unknown, span: Span) => {
      const errorMsg = coerceErrorString(err);
      this.log?.error(
        `procedure ${serviceName}.${procedureName} threw an uncaught error: ${errorMsg}`,
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

    if (isStreamClose(controlFlags)) {
      inputReader.triggerClose();
    } else if (procedure.type === 'rpc' || procedure.type === 'subscription') {
      // Though things can work just fine if they eventually follow up with a stream
      // control message with a close bit set, it's an unusual client implementation!
      this.log?.warn(`${procedure.type} sent an init without a stream close`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
      });
    }

    const serviceContextWithTransportInfo: ServiceContextWithTransportInfo<object> =
      {
        ...this.getContext(service, serviceName),
        to: initMessage.to,
        from: initMessage.from,
        streamId: initMessage.streamId,
        session,
        metadata: sessionMeta,
      };

    this.openStreams.add(streamId);

    switch (procedure.type) {
      case 'rpc':
        void createHandlerSpan(
          procedure.type,
          initMessage,
          async (span): InputHandlerReturn => {
            try {
              const outputMessage = await procedure.handler(
                serviceContextWithTransportInfo,
                initPayload,
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
        void createHandlerSpan(
          procedure.type,
          initMessage,
          async (span): InputHandlerReturn => {
            try {
              procDispose = await procedure.handler(
                serviceContextWithTransportInfo,
                initPayload,
                inputReader,
                outputWriter,
              );

              if (
                procDispose &&
                outputWriter.isClosed() &&
                inputReader.isClosed()
              ) {
                procDispose();
              }
            } catch (err) {
              errorHandler(err, span);
            } finally {
              span.end();
            }
          },
        );

        break;
      case 'subscription':
        void createHandlerSpan(
          procedure.type,
          initMessage,
          async (span): InputHandlerReturn => {
            try {
              procDispose = await procedure.handler(
                serviceContextWithTransportInfo,
                initPayload,
                outputWriter,
              );

              if (
                procDispose &&
                outputWriter.isClosed() &&
                inputReader.isClosed()
              ) {
                procDispose();
              }
            } catch (err) {
              errorHandler(err, span);
            } finally {
              span.end();
            }
          },
        );
        break;
      case 'upload':
        void createHandlerSpan(
          procedure.type,
          initMessage,
          async (span): InputHandlerReturn => {
            try {
              const outputMessage = await procedure.handler(
                serviceContextWithTransportInfo,
                initPayload,
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
        this.log?.warn(
          `got request for invalid procedure type ${
            (procedure as AnyProcedure).type
          } at ${serviceName}.${procedureName}`,
          { ...session.loggingMetadata, transportMessage: initMessage },
        );

        return;
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
