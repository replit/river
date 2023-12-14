import { Static } from '@sinclair/typebox';
import { Connection, Transport } from '../transport/transport';
import { AnyProcedure, AnyService, PayloadType } from './builder';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import {
  ControlMessagePayloadSchema,
  OpaqueTransportMessage,
  TransportMessage,
  isStreamClose,
  isStreamOpen,
  reply,
  closeStream,
} from '../transport/message';
import { ServiceContext } from './context';
import { log } from '../logging';
import { Value } from '@sinclair/typebox/value';
import {
  Err,
  Result,
  RiverError,
  RiverUncaughtSchema,
  UNCAUGHT_ERROR,
} from './result';

/**
 * Represents a server with a set of services. Use {@link createServer} to create it.
 * @template Services - The type of services provided by the server.
 */
export interface Server<Services> {
  services: Services;
  streams: Map<string, ProcStream>;
  close(): Promise<void>;
}

interface ProcStream {
  id: string;
  serviceName: string;
  procedureName: string;
  procedure: AnyProcedure;
  incoming: Pushable<TransportMessage>;
  outgoing: Pushable<
    TransportMessage<Result<Static<PayloadType>, Static<RiverError>>>
  >;
  promises: {
    outputHandler: Promise<unknown>;
    inputHandler: Promise<unknown>;
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
export function createServer<Services extends Record<string, AnyService>>(
  transport: Transport<Connection>,
  services: Services,
  extendedContext?: Omit<ServiceContext, 'state'>,
): Server<Services> {
  const contextMap = new Map();
  for (const service of Object.values(services)) {
    contextMap.set(service, {
      ...extendedContext,
      state: service.state,
    });
  }

  const getContext = (service: AnyService) => {
    const context = contextMap.get(service);
    if (!context) {
      const err = `${transport.clientId} -- no context found for ${service.name}`;
      log?.error(err);
      throw new Error(err);
    }

    return context;
  };

  const streamMap = new Map();
  const clientStreams = new Map();

  const createNewProcStream = (message: OpaqueTransportMessage) => {
    if (!isStreamOpen(message.controlFlags)) {
      log?.warn(
        `${transport.clientId} -- couldn't find a matching procedure stream for ${message.serviceName}.${message.procedureName}:${message.streamId}`,
      );
      return;
    }

    if (!message.serviceName || !(message.serviceName in services)) {
      log?.warn(
        `${transport.clientId} -- couldn't find service ${message.serviceName}`,
      );
      return;
    }

    const service = services[message.serviceName];
    const serviceContext = getContext(service);
    if (
      !message.procedureName ||
      !(message.procedureName in service.procedures)
    ) {
      log?.warn(
        `${transport.clientId} -- couldn't find a matching procedure for ${message.serviceName}.${message.procedureName}`,
      );
      return;
    }

    const procedure = service.procedures[message.procedureName] as AnyProcedure;
    const incoming: ProcStream['incoming'] = pushable({ objectMode: true });
    const outgoing: ProcStream['outgoing'] = pushable({ objectMode: true });
    const outputHandler: Promise<unknown> =
      // sending outgoing messages back to client
      (async () => {
        for await (const response of outgoing) {
          transport.send(response);
        }

        // we ended, send a close bit back to the client
        // only subscriptions and streams have streams the
        // handler can close
        if (procedure.type === 'subscription' || procedure.type === 'stream') {
          transport.send(
            closeStream(transport.clientId, message.from, message.streamId),
          );
        }
      })();

    const errorHandler = (err: unknown) => {
      const errorMsg =
        err instanceof Error ? err.message : `[coerced to error] ${err}`;
      log?.error(
        `${transport.clientId} -- procedure ${message.serviceName}.${message.procedureName}:${message.streamId} threw an error: ${errorMsg}`,
      );
      outgoing.push(
        reply(
          message,
          Err({
            code: UNCAUGHT_ERROR,
            message: errorMsg,
          } satisfies Static<typeof RiverUncaughtSchema>),
        ),
      );
    };

    // pump incoming message stream -> handler -> outgoing message stream
    let inputHandler: Promise<unknown>;
    const procHasInitMessage = 'init' in procedure;
    if (procedure.type === 'stream') {
      if (procHasInitMessage) {
        inputHandler = (async () => {
          const initMessage = await incoming.next();
          if (initMessage.done) {
            return;
          }

          return procedure
            .handler(serviceContext, initMessage.value, incoming, outgoing)
            .catch(errorHandler);
        })();
      } else {
        inputHandler = procedure
          .handler(serviceContext, incoming, outgoing)
          .catch(errorHandler);
      }
    } else if (procedure.type === 'rpc') {
      inputHandler = (async () => {
        const inputMessage = await incoming.next();
        if (inputMessage.done) {
          return;
        }

        try {
          const outputMessage = await procedure.handler(
            serviceContext,
            inputMessage.value,
          );
          outgoing.push(outputMessage);
        } catch (err) {
          errorHandler(err);
        }
      })();
    } else if (procedure.type === 'subscription') {
      inputHandler = (async () => {
        const inputMessage = await incoming.next();
        if (inputMessage.done) {
          return;
        }

        try {
          await procedure.handler(serviceContext, inputMessage.value, outgoing);
        } catch (err) {
          errorHandler(err);
        }
      })();
    } else if (procedure.type === 'upload') {
      if (procHasInitMessage) {
        inputHandler = (async () => {
          const initMessage = await incoming.next();
          if (initMessage.done) {
            return;
          }

          try {
            const outputMessage = await procedure.handler(
              serviceContext,
              initMessage.value,
              incoming,
            );
            outgoing.push(outputMessage);
          } catch (err) {
            errorHandler(err);
          }
        })();
      } else {
        inputHandler = (async () => {
          try {
            const outputMessage = await procedure.handler(
              serviceContext,
              incoming,
            );
            outgoing.push(outputMessage);
          } catch (err) {
            errorHandler(err);
          }
        })();
      }
    } else {
      // procedure is inferred to be never here as this is not a valid procedure type
      // we cast just to log
      log?.warn(
        `${transport.clientId} -- got request for invalid procedure type ${
          (procedure as AnyProcedure).type
        } at ${message.serviceName}.${message.procedureName}`,
      );
      return;
    }

    const procStream: ProcStream = {
      id: message.streamId,
      incoming,
      outgoing,
      serviceName: message.serviceName,
      procedureName: message.procedureName,
      procedure,
      promises: { inputHandler, outputHandler },
    };

    streamMap.set(message.streamId, procStream);

    // add this stream to ones from that client so we can clean it up in the case of a disconnect without close
    const streamsFromThisClient = clientStreams.get(message.from) ?? new Set();
    streamsFromThisClient.add(message.streamId);
    clientStreams.set(message.from, streamsFromThisClient);
    return procStream;
  };

  const cleanupStream = async (id: string) => {
    const stream = streamMap.get(id);
    if (!stream) {
      return;
    }

    stream.incoming.end();
    await stream.promises.inputHandler;
    stream.outgoing.end();
    await stream.promises.outputHandler;
    streamMap.delete(id);
  };

  const pushToStream = async (
    procStream: ProcStream,
    message: OpaqueTransportMessage,
    isInit?: boolean,
  ) => {
    const procedure = procStream.procedure;
    const procHasInitMessage = 'init' in procedure;

    if (
      (isInit &&
        procHasInitMessage &&
        Value.Check(procedure.init, message.payload)) ||
      Value.Check(procedure.input, message.payload)
    ) {
      procStream.incoming.push(message as TransportMessage);
    } else if (!Value.Check(ControlMessagePayloadSchema, message.payload)) {
      log?.error(
        `${transport.clientId} -- procedure ${procStream.serviceName}.${
          procStream.procedureName
        } received invalid payload: ${JSON.stringify(message.payload)}`,
      );
    }

    if (isStreamClose(message.controlFlags)) {
      await cleanupStream(message.streamId);
    }
  };

  const handler = async (message: OpaqueTransportMessage) => {
    if (message.to !== transport.clientId) {
      log?.info(
        `${transport.clientId} -- got msg with destination that isn't the server, ignoring`,
      );
      return;
    }

    let procStream = streamMap.get(message.streamId);
    const isInitMessage = !procStream;

    procStream ||= createNewProcStream(message);
    if (!procStream) {
      return;
    }

    return pushToStream(procStream, message, isInitMessage);
  };

  transport.addEventListener('message', handler);
  return {
    services,
    streams: streamMap,
    async close() {
      transport.removeEventListener('message', handler);
      await Promise.all(Array.from(streamMap.keys()).map(cleanupStream));
    },
  };
}
