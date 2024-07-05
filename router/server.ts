import { Static } from '@sinclair/typebox';
import { Connection, ServerTransport } from '../transport';
import { AnyProcedure, PayloadType } from './procedures';
import {
  AnyService,
  InstantiatedServiceSchemaMap,
  AnyServiceSchemaMap,
} from './services';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import {
  ControlMessagePayloadSchema,
  OpaqueTransportMessage,
  isStreamClose,
  isStreamOpen,
  ControlFlags,
  closeStreamMessage,
  PartialTransportMessage,
} from '../transport/message';
import {
  ServiceContext,
  ServiceContextWithState,
  ServiceContextWithTransportInfo,
} from './context';
import { Logger } from '../logging/log';
import { Value } from '@sinclair/typebox/value';
import {
  Err,
  Result,
  RiverError,
  RiverUncaughtSchema,
  UNCAUGHT_ERROR,
} from './result';
import { EventMap } from '../transport/events';
import { coerceErrorString } from '../util/stringify';
import { Span, SpanStatusCode } from '@opentelemetry/api';
import { createHandlerSpan } from '../tracing';
import { ServerHandshakeOptions } from './handshake';

/**
 * Represents a server with a set of services. Use {@link createServer} to create it.
 * @template Services - The type of services provided by the server.
 */
export interface Server<Services extends AnyServiceSchemaMap> {
  services: InstantiatedServiceSchemaMap<Services>;
  streams: Map<string, ProcStream>;
}

interface ProcStream {
  id: string;
  serviceName: string;
  procedureName: string;
  incoming: Pushable<PayloadType>;
  outgoing: Pushable<Result<Static<PayloadType>, Static<RiverError>>>;
  promises: {
    outputHandler: Promise<unknown>;
    inputHandler: Promise<unknown>;
  };
}

class RiverServer<Services extends AnyServiceSchemaMap> {
  transport: ServerTransport<Connection>;
  services: InstantiatedServiceSchemaMap<Services>;
  contextMap: Map<AnyService, ServiceContextWithState<object>>;
  // map of streamId to ProcStream
  streamMap: Map<string, ProcStream>;

  // map of sessionId to streamIds
  sessionToStreamId: Map<string, Set<string>>;

  // streams that are in the process of being cleaned up
  // this is to prevent output handlers from sending after the stream is cleaned up
  sessionsBeingCleanedUp = new Set<string>();

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
    this.streamMap = new Map();
    this.sessionToStreamId = new Map();
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

  onMessage = async (message: OpaqueTransportMessage) => {
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
    const isInitMessage = !procStream;

    // create a proc stream if it doesnt exist
    procStream ||= this.createNewProcStream(message);
    if (!procStream) {
      // if we fail to create a proc stream, just abort
      return;
    }

    await this.pushToStream(procStream, message, isInitMessage);
  };

  onSessionStatus = async (evt: EventMap['sessionStatus']) => {
    if (evt.status === 'connect') {
      this.sessionToStreamId.set(evt.session.id, new Set());
      return;
    }

    // cleanup
    this.log?.info(
      `got session disconnect from ${evt.session.to}, cleaning up streams for session`,
      evt.session.loggingMetadata,
    );

    const streamsFromThisClient = this.sessionToStreamId.get(evt.session.id);
    if (!streamsFromThisClient) return;

    this.sessionsBeingCleanedUp.add(evt.session.id);
    await Promise.all(
      Array.from(streamsFromThisClient).map(this.cleanupStream),
    );
    this.sessionToStreamId.delete(evt.session.id);
    this.sessionsBeingCleanedUp.delete(evt.session.id);
  };

  createNewProcStream(message: OpaqueTransportMessage) {
    if (!isStreamOpen(message.controlFlags)) {
      this.log?.error(
        `can't create a new procedure stream from a message that doesn't have the stream open bit set`,
        {
          clientId: this.transport.clientId,
          transportMessage: message,
          tags: ['invariant-violation'],
        },
      );
      return;
    }

    if (!message.procedureName || !message.serviceName) {
      this.log?.warn(
        `missing procedure or service name in stream open message`,
        {
          clientId: this.transport.clientId,
          transportMessage: message,
        },
      );
      return;
    }

    if (!(message.serviceName in this.services)) {
      this.log?.warn(`couldn't find service ${message.serviceName}`, {
        clientId: this.transport.clientId,
        transportMessage: message,
      });
      return;
    }

    const service = this.services[message.serviceName];
    const serviceContext = this.getContext(service, message.serviceName);
    if (!(message.procedureName in service.procedures)) {
      this.log?.warn(
        `couldn't find a matching procedure for ${message.serviceName}.${message.procedureName}`,
        {
          clientId: this.transport.clientId,
          transportMessage: message,
        },
      );
      return;
    }

    const session = this.transport.sessions.get(message.from);
    if (!session) {
      this.log?.warn(`couldn't find session for ${message.from}`, {
        clientId: this.transport.clientId,
        transportMessage: message,
      });
      return;
    }

    const to = session.to;
    const sessionId = session.id;
    const sessionLoggingMetadata = session.loggingMetadata;
    const procedure = service.procedures[message.procedureName];
    const incoming: ProcStream['incoming'] = pushable({ objectMode: true });
    const outgoing: ProcStream['outgoing'] = pushable({ objectMode: true });
    const needsClose =
      procedure.type === 'subscription' || procedure.type === 'stream';
    const disposables: Array<() => void> = [];

    const wrappedSend = (payload: PartialTransportMessage) => {
      if (!this.sessionsBeingCleanedUp.has(sessionId)) {
        this.transport.send(to, payload);
      }
    };

    const outputHandler: Promise<unknown> =
      // sending outgoing messages back to client
      needsClose
        ? // subscription and stream case, we need to send a close bit after the response stream
          (async () => {
            for await (const response of outgoing) {
              wrappedSend({
                streamId: message.streamId,
                controlFlags: 0,
                payload: response,
              });
            }

            // we ended, send a close bit back to the client
            wrappedSend(closeStreamMessage(message.streamId));

            // call disposables returned from handlers
            disposables.forEach((d) => d());
          })()
        : // rpc and upload case, we just send the response back with close bit
          (async () => {
            const response = await outgoing.next().then((res) => res.value);
            if (response) {
              wrappedSend({
                streamId: message.streamId,
                controlFlags: ControlFlags.StreamClosedBit,
                payload: response,
              });

              // call disposables returned from handlers
              disposables.forEach((d) => d());
            }
          })();

    const errorHandler = (err: unknown, span: Span) => {
      const errorMsg = coerceErrorString(err);
      this.log?.error(
        `procedure ${message.serviceName}.${message.procedureName} threw an uncaught error: ${errorMsg}`,
        sessionLoggingMetadata,
      );

      span.recordException(err instanceof Error ? err : new Error(errorMsg));
      span.setStatus({ code: SpanStatusCode.ERROR });
      outgoing.push(
        Err({
          code: UNCAUGHT_ERROR,
          message: errorMsg,
        } satisfies Static<typeof RiverUncaughtSchema>),
      );
    };

    const sessionMeta = this.transport.sessionHandshakeMetadata.get(to);
    if (!sessionMeta) {
      this.log?.error(`session doesn't have handshake metadata`, {
        ...sessionLoggingMetadata,
        tags: ['invariant-violation'],
      });
      return;
    }

    // pump incoming message stream -> handler -> outgoing message stream
    let inputHandler: Promise<unknown>;
    const procHasInitMessage = 'init' in procedure;
    const serviceContextWithTransportInfo: ServiceContextWithTransportInfo<object> =
      {
        ...serviceContext,
        to: message.to,
        from: message.from,
        streamId: message.streamId,
        metadata: sessionMeta,
      };

    switch (procedure.type) {
      case 'rpc':
        inputHandler = createHandlerSpan(
          procedure.type,
          message,
          async (span) => {
            const inputMessage = await incoming.next();
            if (inputMessage.done) {
              return;
            }
            try {
              const outputMessage = await procedure.handler(
                serviceContextWithTransportInfo,
                inputMessage.value,
              );
              outgoing.push(outputMessage);
            } catch (err) {
              errorHandler(err, span);
            } finally {
              span.end();
            }
          },
        );
        break;
      case 'stream':
        if (procHasInitMessage) {
          inputHandler = createHandlerSpan(
            procedure.type,
            message,
            async (span) => {
              const initMessage = await incoming.next();
              if (initMessage.done) {
                return;
              }

              try {
                const dispose = await procedure.handler(
                  serviceContextWithTransportInfo,
                  initMessage.value,
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
        } else {
          inputHandler = createHandlerSpan(
            procedure.type,
            message,
            async (span) => {
              try {
                const dispose = await procedure.handler(
                  serviceContextWithTransportInfo,
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
        }
        break;
      case 'subscription':
        inputHandler = createHandlerSpan(
          procedure.type,
          message,
          async (span) => {
            const inputMessage = await incoming.next();
            if (inputMessage.done) {
              return;
            }

            try {
              const dispose = await procedure.handler(
                serviceContextWithTransportInfo,
                inputMessage.value,
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
        if (procHasInitMessage) {
          inputHandler = createHandlerSpan(
            procedure.type,
            message,
            async (span) => {
              const initMessage = await incoming.next();
              if (initMessage.done) {
                return;
              }
              try {
                const outputMessage = await procedure.handler(
                  serviceContextWithTransportInfo,
                  initMessage.value,
                  incoming,
                );

                outgoing.push(outputMessage);
              } catch (err) {
                errorHandler(err, span);
              } finally {
                span.end();
              }
            },
          );
        } else {
          inputHandler = createHandlerSpan(
            procedure.type,
            message,
            async (span) => {
              try {
                const outputMessage = await procedure.handler(
                  serviceContextWithTransportInfo,
                  incoming,
                );

                outgoing.push(outputMessage);
              } catch (err) {
                errorHandler(err, span);
              } finally {
                span.end();
              }
            },
          );
        }

        break;
      default:
        // procedure is inferred to be never here as this is not a valid procedure type
        // we cast just to this.log
        this.log?.warn(
          `got request for invalid procedure type ${
            (procedure as AnyProcedure).type
          } at ${message.serviceName}.${message.procedureName}`,
          { ...sessionLoggingMetadata, transportMessage: message },
        );
        return;
    }

    const procStream: ProcStream = {
      id: message.streamId,
      incoming,
      outgoing,
      serviceName: message.serviceName,
      procedureName: message.procedureName,
      promises: { inputHandler, outputHandler },
    };

    this.streamMap.set(message.streamId, procStream);

    // add this stream to ones from that client so we can clean it up in the case of a disconnect without close
    const streamsForThisSession =
      this.sessionToStreamId.get(sessionId) ?? new Set();
    streamsForThisSession.add(message.streamId);
    this.sessionToStreamId.set(sessionId, streamsForThisSession);

    return procStream;
  }

  async pushToStream(
    procStream: ProcStream,
    message: OpaqueTransportMessage,
    isInit?: boolean,
  ) {
    const { serviceName, procedureName } = procStream;
    const procedure = this.services[serviceName].procedures[procedureName];
    const procHasInitMessage = 'init' in procedure;

    if (isInit && procHasInitMessage) {
      if (Value.Check(procedure.init, message.payload)) {
        procStream.incoming.push(message.payload as PayloadType);
      } else {
        this.log?.error(
          `procedure ${serviceName}.${procedureName} received invalid init payload`,
          {
            clientId: this.transport.clientId,
            transportMessage: message,
            validationErrors: [
              ...Value.Errors(procedure.init, message.payload),
            ],
          },
        );
      }
    } else if (Value.Check(procedure.input, message.payload)) {
      procStream.incoming.push(message.payload as PayloadType);
    } else if (!Value.Check(ControlMessagePayloadSchema, message.payload)) {
      // whelp we got a message that isn't a control message and doesn't match the procedure input
      // so definitely not a valid payload
      this.log?.error(
        `procedure ${serviceName}.${procedureName} received invalid payload`,
        {
          clientId: this.transport.clientId,
          transportMessage: message,
          validationErrors: [...Value.Errors(procedure.input, message.payload)],
        },
      );
    }

    if (isStreamClose(message.controlFlags)) {
      await this.cleanupStream(message.streamId);

      const streamsFromThisClient = this.sessionToStreamId.get(message.from);
      if (streamsFromThisClient) {
        streamsFromThisClient.delete(message.streamId);
        if (streamsFromThisClient.size === 0) {
          this.sessionToStreamId.delete(message.from);
        }
      }
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

  cleanupStream = async (id: string) => {
    const stream = this.streamMap.get(id);
    if (!stream) {
      return;
    }

    // end the streams and wait for the handlers to finish
    stream.incoming.end();
    await stream.promises.inputHandler;
    stream.outgoing.end();
    await stream.promises.outputHandler;
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
