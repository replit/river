import { Static } from '@sinclair/typebox';
import { ServerTransport } from '../transport/transport';
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
  TransportClientId,
  ControlFlags,
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
import { Connection } from '../transport';
import { coerceErrorString } from '../util/stringify';

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
  // map of client to their open streams by streamId
  clientStreams: Map<TransportClientId, Set<string>>;
  disconnectedSessions: Set<TransportClientId>;

  constructor(
    transport: ServerTransport<Connection>,
    services: Services,
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
        fullTransportMessage: message,
      });
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

  createNewProcStream(message: OpaqueTransportMessage) {
    if (!isStreamOpen(message.controlFlags)) {
      log?.error(
        `can't create a new procedure stream from a message that doesn't have the stream open bit set`,
        { clientId: this.transport.clientId, fullTransportMessage: message },
      );
      return;
    }

    if (!message.procedureName || !message.serviceName) {
      log?.warn(`missing procedure or service name in stream open message`, {
        clientId: this.transport.clientId,
        fullTransportMessage: message,
      });
      return;
    }

    if (!(message.serviceName in this.services)) {
      log?.warn(`couldn't find service ${message.serviceName}`, {
        clientId: this.transport.clientId,
        fullTransportMessage: message,
      });
      return;
    }

    const service = this.services[message.serviceName];
    const serviceContext = this.getContext(service, message.serviceName);
    if (!(message.procedureName in service.procedures)) {
      log?.warn(
        `couldn't find a matching procedure for ${message.serviceName}.${message.procedureName}`,
        {
          clientId: this.transport.clientId,
          fullTransportMessage: message,
        },
      );
      return;
    }

    const session = this.transport.sessions.get(message.from);
    if (!session) {
      log?.warn(`couldn't find session for ${message.from}`, {
        clientId: this.transport.clientId,
        fullTransportMessage: message,
      });
      return;
    }

    const procedure = service.procedures[message.procedureName];
    const incoming: ProcStream['incoming'] = pushable({ objectMode: true });
    const outgoing: ProcStream['outgoing'] = pushable({ objectMode: true });
    const needsClose =
      procedure.type === 'subscription' || procedure.type === 'stream';
    const disposables: Array<() => void> = [];

    const outputHandler: Promise<unknown> =
      // sending outgoing messages back to client
      needsClose
        ? // subscription and stream case, we need to send a close bit after the response stream
          (async () => {
            for await (const response of outgoing) {
              this.transport.send(session.to, {
                streamId: message.streamId,
                controlFlags: 0,
                payload: response,
              });
            }

            // we ended, send a close bit back to the client
            // also, if the client has disconnected, we don't need to send a close
            if (!this.disconnectedSessions.has(message.from)) {
              this.transport.sendCloseStream(session.to, message.streamId);
            }

            // call disposables returned from handlers
            disposables.forEach((d) => d());
          })()
        : // rpc and upload case, we just send the response back with close bit
          (async () => {
            const response = await outgoing.next().then((res) => res.value);
            if (response) {
              this.transport.send(session.to, {
                streamId: message.streamId,
                controlFlags: ControlFlags.StreamClosedBit,
                payload: response,
              });

              // call disposables returned from handlers
              disposables.forEach((d) => d());
            }
          })();

    const errorHandler = (err: unknown) => {
      const errorMsg = coerceErrorString(err);
      log?.error(
        `procedure ${message.serviceName}.${message.procedureName} threw an uncaught error: ${errorMsg}`,
        session.loggingMetadata,
      );

      outgoing.push(
        Err({
          code: UNCAUGHT_ERROR,
          message: errorMsg,
        } satisfies Static<typeof RiverUncaughtSchema>),
      );
    };

    // by this point, our sessions should always have their handshake metadata
    if (session.handshakeMetadata === undefined) {
      log?.error(
        `session ${message.from} doesn't have handshake metadata, can't proceed with procedure`,
        session.loggingMetadata,
      );
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
        // we've already validated that the session has handshake metadata
        session: session as ServiceContextWithTransportInfo<object>['session'],
      };

    switch (procedure.type) {
      case 'rpc':
        inputHandler = (async () => {
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
            errorHandler(err);
          }
        })();
        break;
      case 'stream':
        if (procHasInitMessage) {
          inputHandler = (async () => {
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
              errorHandler(err);
            }
          })();
        } else {
          inputHandler = procedure
            .handler(serviceContextWithTransportInfo, incoming, outgoing)
            .catch(errorHandler);
        }
        break;
      case 'subscription':
        inputHandler = (async () => {
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
            errorHandler(err);
          }
        })();
        break;
      case 'upload':
        if (procHasInitMessage) {
          inputHandler = (async () => {
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

              if (!this.disconnectedSessions.has(message.from)) {
                outgoing.push(outputMessage);
              }
            } catch (err) {
              errorHandler(err);
            }
          })();
        } else {
          inputHandler = (async () => {
            try {
              const outputMessage = await procedure.handler(
                serviceContextWithTransportInfo,
                incoming,
              );

              if (!this.disconnectedSessions.has(message.from)) {
                outgoing.push(outputMessage);
              }
            } catch (err) {
              errorHandler(err);
            }
          })();
        }
        break;
      default:
        // procedure is inferred to be never here as this is not a valid procedure type
        // we cast just to log
        log?.warn(
          `got request for invalid procedure type ${
            (procedure as AnyProcedure).type
          } at ${message.serviceName}.${message.procedureName}`,
          { ...session.loggingMetadata, fullTransportMessage: message },
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
    const streamsFromThisClient =
      this.clientStreams.get(message.from) ?? new Set();
    streamsFromThisClient.add(message.streamId);
    this.clientStreams.set(message.from, streamsFromThisClient);

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

    if (
      isInit &&
      procHasInitMessage &&
      Value.Check(procedure.init, message.payload)
    ) {
      procStream.incoming.push(message.payload as PayloadType);
    } else if (Value.Check(procedure.input, message.payload)) {
      procStream.incoming.push(message.payload as PayloadType);
    } else if (!Value.Check(ControlMessagePayloadSchema, message.payload)) {
      log?.error(
        `procedure ${serviceName}.${procedureName} received invalid payload`,
        { clientId: this.transport.clientId, fullTransportMessage: message },
      );
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
 * @param extendedContext - An optional object containing additional context to be passed to all services.
 * @returns A promise that resolves to a server instance with the registered services.
 */
export function createServer<Services extends AnyServiceSchemaMap>(
  transport: ServerTransport<Connection>,
  services: Services,
  extendedContext?: Omit<ServiceContext, 'state'>,
): Server<Services> {
  return new RiverServer(transport, services, extendedContext);
}
