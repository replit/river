import { Static } from '@sinclair/typebox';
import { ServerTransport } from '../transport/transport';
import { AnyProcedure, PayloadType } from './procedures';
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
  ServerHandshakeOptions,
} from '../transport/message';
import {
  ServiceContext,
  ServiceContextWithState,
  ServiceContextWithTransportInfo,
} from './context';
import { log } from '../logging/log';
import { Value } from '@sinclair/typebox/value';
import {
  Err,
  Result,
  RiverError,
  RiverUncaughtSchema,
  UNCAUGHT_ERROR,
} from './result';
import { EventMap } from '../transport/events';
import { Connection } from '../transport/session';
import { coerceErrorString } from '../util/stringify';
import { Span, SpanStatusCode } from '@opentelemetry/api';
import { createHandlerSpan } from '../tracing';
import { ReadStreamImpl, WriteStreamImpl } from './streams';

/**
 * Represents a server with a set of services. Use {@link createServer} to create it.
 * @template Services - The type of services provided by the server.
 */
export interface Server<Services extends AnyServiceSchemaMap> {
  services: InstantiatedServiceSchemaMap<Services>;
  streams: Map<string, ProcStream>;
  close(): Promise<void>;
}

interface ProcStream {
  id: string;
  serviceName: string;
  procedureName: string;
  incoming: ReadStreamImpl<PayloadType>;
  outgoing: WriteStreamImpl<Result<Static<PayloadType>, Static<RiverError>>>;
  promises: {
    inputHandler: Promise<unknown>;
  };
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
      const instance = service.instantiate();
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
  }

  get streams() {
    return this.streamMap;
  }

  onMessage = async (message: OpaqueTransportMessage) => {
    if (message.to !== this.transport.clientId) {
      log?.info(`got msg with destination that isn't this server, ignoring`, {
        clientId: this.transport.clientId,
        transportMessage: message,
      });
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
  onSessionStatus = async (evt: EventMap['sessionStatus']) => {
    if (evt.status !== 'disconnect') return;

    const disconnectedClientId = evt.session.to;
    log?.info(
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

  async close() {
    this.transport.removeEventListener('message', this.onMessage);
    this.transport.removeEventListener('sessionStatus', this.onSessionStatus);
    await Promise.all([...this.streamMap.keys()].map(this.cleanupStream));

    for (const context of this.contextMap.values()) {
      if (Symbol.dispose in context.state) {
        const dispose = context.state[Symbol.dispose];
        if (typeof dispose === 'function') {
          dispose();
        }
      }
    }
  }

  createNewProcStream(initMessage: OpaqueTransportMessage) {
    if (!isStreamOpen(initMessage.controlFlags)) {
      log?.error(
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
      log?.warn(`missing procedure or service name in stream open message`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
      });
      return;
    }

    if (!(initMessage.serviceName in this.services)) {
      log?.warn(`couldn't find service ${initMessage.serviceName}`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
      });
      return;
    }

    const service = this.services[initMessage.serviceName];
    const serviceContext = this.getContext(service, initMessage.serviceName);
    if (!(initMessage.procedureName in service.procedures)) {
      log?.warn(
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
      log?.warn(`couldn't find session for ${initMessage.from}`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
      });
      return;
    }

    const procedure = service.procedures[initMessage.procedureName];
    const readStreamRequestCloseNotImplemented = () => void 0;
    const incoming: ProcStream['incoming'] = new ReadStreamImpl(
      readStreamRequestCloseNotImplemented,
    );
    const needsClose =
      procedure.type === 'subscription' || procedure.type === 'stream';
    const disposables: Array<() => void> = [];
    const outgoing: ProcStream['outgoing'] = new WriteStreamImpl(
      (response) => {
        this.transport.send(session.to, {
          streamId: initMessage.streamId,
          controlFlags: needsClose ? 0 : ControlFlags.StreamClosedBit,
          payload: response,
        });
      },
      () => {
        if (needsClose && !this.disconnectedSessions.has(initMessage.from)) {
          // we ended, send a close bit back to the client
          // also, if the client has disconnected, we don't need to send a close
          this.transport.sendCloseStream(session.to, initMessage.streamId);
        }
        // call disposables returned from handlers
        disposables.forEach((d) => d());
      },
    );

    const errorHandler = (err: unknown, span: Span) => {
      const errorMsg = coerceErrorString(err);
      log?.error(
        `procedure ${initMessage.serviceName}.${initMessage.procedureName} threw an uncaught error: ${errorMsg}`,
        session.loggingMetadata,
      );

      span.recordException(err instanceof Error ? err : new Error(errorMsg));
      span.setStatus({ code: SpanStatusCode.ERROR });
      outgoing.write(
        Err({
          code: UNCAUGHT_ERROR,
          message: errorMsg,
        } satisfies Static<typeof RiverUncaughtSchema>),
      );
    };

    const sessionMeta = this.transport.sessionHandshakeMetadata.get(session);
    if (!sessionMeta) {
      log?.error(`session doesn't have handshake metadata`, {
        ...session.loggingMetadata,
        tags: ['invariant-violation'],
      });
      return;
    }

    // pump incoming message stream -> handler -> outgoing message stream
    let inputHandler: Promise<unknown>;
    const serviceContextWithTransportInfo: ServiceContextWithTransportInfo<object> =
      {
        ...serviceContext,
        to: initMessage.to,
        from: initMessage.from,
        streamId: initMessage.streamId,
        session,
        metadata: sessionMeta,
      };

    switch (procedure.type) {
      case 'rpc':
        inputHandler = createHandlerSpan(
          procedure.type,
          initMessage,
          async (span) => {
            if (!Value.Check(procedure.init, initMessage.payload)) {
              log?.error('rpc init failed validation', {
                clientId: this.transport.clientId,
                transportMessage: initMessage,
              });

              errorHandler('rpc init failed validation', span);
              span.end();

              return;
            }

            try {
              const outputMessage = await procedure.handler(
                serviceContextWithTransportInfo,
                initMessage.payload,
              );
              outgoing.write(outputMessage);
            } catch (err) {
              errorHandler(err, span);
            } finally {
              span.end();
            }
          },
        );
        break;
      case 'stream':
        inputHandler = createHandlerSpan(
          procedure.type,
          initMessage,
          async (span) => {
            if (!Value.Check(procedure.init, initMessage.payload)) {
              log?.error(
                'procedure requires init, but first message failed validation',
                {
                  clientId: this.transport.clientId,
                  transportMessage: initMessage,
                },
              );

              errorHandler(
                'procedure requires init, but first message failed validation',
                span,
              );
              span.end();

              return;
            }

            try {
              const dispose = await procedure.handler(
                serviceContextWithTransportInfo,
                initMessage.payload,
                incoming,
                outgoing,
              );

              if (dispose) {
                disposables.push(dispose);
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
        inputHandler = createHandlerSpan(
          procedure.type,
          initMessage,
          async (span) => {
            if (!Value.Check(procedure.init, initMessage.payload)) {
              log?.error('subscription init failed validation', {
                clientId: this.transport.clientId,
                transportMessage: initMessage,
              });

              errorHandler('subscription init failed validation', span);
              span.end();

              return;
            }

            try {
              const dispose = await procedure.handler(
                serviceContextWithTransportInfo,
                initMessage.payload,
                outgoing,
              );

              if (dispose) {
                disposables.push(dispose);
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
        inputHandler = createHandlerSpan(
          procedure.type,
          initMessage,
          async (span) => {
            if (!Value.Check(procedure.init, initMessage.payload)) {
              log?.error(
                'procedure requires init, but first message failed validation',
                {
                  clientId: this.transport.clientId,
                  transportMessage: initMessage,
                },
              );

              errorHandler(
                'procedure requires init, but first message failed validation',
                span,
              );
              span.end();

              return;
            }

            try {
              const outputMessage = await procedure.handler(
                serviceContextWithTransportInfo,
                initMessage.payload,
                incoming,
              );

              if (!this.disconnectedSessions.has(initMessage.from)) {
                outgoing.write(outputMessage);
              }
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
        // we cast just to log
        log?.warn(
          `got request for invalid procedure type ${
            (procedure as AnyProcedure).type
          } at ${initMessage.serviceName}.${initMessage.procedureName}`,
          { ...session.loggingMetadata, transportMessage: initMessage },
        );
        return;
    }

    const procStream: ProcStream = {
      id: initMessage.streamId,
      incoming,
      outgoing,
      serviceName: initMessage.serviceName,
      procedureName: initMessage.procedureName,
      promises: { inputHandler },
    };

    this.streamMap.set(initMessage.streamId, procStream);

    // add this stream to ones from that client so we can clean it up in the case of a disconnect without close
    const streamsFromThisClient =
      this.clientStreams.get(initMessage.from) ?? new Set();
    streamsFromThisClient.add(initMessage.streamId);
    this.clientStreams.set(initMessage.from, streamsFromThisClient);

    return procStream;
  }

  async pushToStream(
    procStream: ProcStream,
    message: OpaqueTransportMessage,
    isInit?: boolean,
  ) {
    const { serviceName, procedureName } = procStream;
    const procedure = this.services[serviceName].procedures[procedureName];

    // Init message is consumed during stream instantiation
    if (!isInit) {
      if (Value.Check(procedure.init, message.payload)) {
        procStream.incoming.pushValue(message.payload as PayloadType);
      } else if (!Value.Check(ControlMessagePayloadSchema, message.payload)) {
        // whelp we got a message that isn't a control message and doesn't match the procedure input
        // so definitely not a valid payload
        log?.error(
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
      await this.cleanupStream(message.streamId);

      const streamsFromThisClient = this.clientStreams.get(message.from);
      if (streamsFromThisClient) {
        streamsFromThisClient.delete(message.streamId);
        if (streamsFromThisClient.size === 0) {
          this.clientStreams.delete(message.from);
        }
      }
    }
  }

  private getContext(service: AnyService, serviceName: string) {
    const context = this.contextMap.get(service);
    if (!context) {
      const err = `no context found for ${serviceName}`;
      log?.error(err, {
        clientId: this.transport.clientId,
        tags: ['invariant-violation'],
      });
      throw new Error(err);
    }

    return context;
  }

  cleanupStream = async (id: string) => {
    const stream = this.streamMap.get(id);
    if (!stream) {
      return;
    }

    // end the streams and wait for the handlers to finish
    if (!stream.incoming.isClosed()) {
      stream.incoming.triggerClose();
    }
    await stream.promises.inputHandler;
    stream.outgoing.close();
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
