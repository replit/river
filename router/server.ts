import { Static, TObject } from '@sinclair/typebox';
import { Connection, Transport } from '../transport/transport';
import { AnyProcedure, AnyService } from './builder';
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
import { ServiceContext, ServiceContextWithState } from './context';
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
  close(): Promise<void>;
}

interface ProcStream {
  incoming: Pushable<TransportMessage>;
  outgoing: Pushable<
    TransportMessage<Result<Static<TObject>, Static<RiverError>>>
  >;
  openPromises: Array<Promise<unknown>>;
  // TODO: abort controller probably goes here
}

/**
 * Creates a server instance that listens for incoming messages from a transport and routes them to the appropriate service and procedure.
 * The server tracks the state of each service along with open streams and the extended context object.
 * @param transport - The transport to listen to.
 * @param services - An object containing all the services to be registered on the server.
 * @param extendedContext - An optional object containing additional context to be passed to all services.
 * @returns A promise that resolves to a server instance with the registered services.
 */
export async function createServer<Services extends Record<string, AnyService>>(
  transport: Transport<Connection>,
  services: Services,
  extendedContext?: Omit<ServiceContext, 'state'>,
): Promise<Server<Services>> {
  const contextMap: Map<
    AnyService,
    ServiceContextWithState<object>
  > = new Map();
  // map of streamId to ProcStream
  const streamMap: Map<string, ProcStream> = new Map();

  function getContext(service: AnyService) {
    const context = contextMap.get(service);
    if (!context) {
      const err = `${transport.clientId} -- no context found for ${service.name}`;
      log?.error(err);
      throw new Error(err);
    }

    return context;
  }

  // populate the context map
  for (const service of Object.values(services)) {
    contextMap.set(service, { ...extendedContext, state: service.state });
  }

  const handler = async (message: OpaqueTransportMessage) => {
    if (message.to !== transport.clientId) {
      log?.info(
        `${transport.clientId} -- got msg with destination that isn't the server, ignoring`,
      );
      return;
    }

    if (!(message.serviceName in services)) {
      log?.warn(
        `${transport.clientId} -- couldn't find service ${message.serviceName}`,
      );
      return;
    }

    const service = services[message.serviceName];
    const serviceContext = getContext(service);
    if (!(message.procedureName in service.procedures)) {
      log?.warn(
        `${transport.clientId} -- couldn't find a matching procedure for ${message.serviceName}.${message.procedureName}`,
      );
      return;
    }

    const procedure = service.procedures[message.procedureName] as AnyProcedure;
    const streamIdx = `${message.serviceName}.${message.procedureName}:${message.streamId}`;
    if (isStreamOpen(message.controlFlags) && !streamMap.has(streamIdx)) {
      const incoming: ProcStream['incoming'] = pushable({ objectMode: true });
      const outgoing: ProcStream['outgoing'] = pushable({ objectMode: true });
      const openPromises: Array<Promise<unknown>> = [
        // sending outgoing messages back to client
        (async () => {
          for await (const response of outgoing) {
            transport.send(response);
          }

          // we ended, send a close bit back to the client
          transport.send(
            closeStream(
              transport.clientId,
              message.from,
              message.serviceName,
              message.procedureName,
              message.streamId,
            ),
          );
        })(),
      ];

      function errorHandler(err: unknown) {
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
      }

      // pump incoming message stream -> handler -> outgoing message stream
      if (procedure.type === 'stream') {
        openPromises.push(
          procedure
            .handler(serviceContext, incoming, outgoing)
            .catch(errorHandler),
        );
      } else if (procedure.type === 'rpc') {
        openPromises.push(
          (async () => {
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
          })(),
        );
      } else if (procedure.type === 'subscription') {
        openPromises.push(
          (async () => {
            const inputMessage = await incoming.next();
            if (inputMessage.done) {
              return;
            }

            try {
              await procedure.handler(
                serviceContext,
                inputMessage.value,
                outgoing,
              );
            } catch (err) {
              errorHandler(err);
            }
          })(),
        );
      }

      streamMap.set(streamIdx, {
        incoming,
        outgoing,
        openPromises,
      });
    }

    const procStream = streamMap.get(streamIdx);
    if (!procStream) {
      log?.warn(
        `${transport.clientId} -- couldn't find a matching procedure stream for ${message.serviceName}.${message.procedureName}:${message.streamId}`,
      );
      return;
    }

    if (Value.Check(procedure.input, message.payload)) {
      procStream.incoming.push(message as TransportMessage);
    } else if (!Value.Check(ControlMessagePayloadSchema, message.payload)) {
      log?.error(
        `${transport.clientId} -- procedure ${message.serviceName}.${
          message.procedureName
        } received invalid payload: ${JSON.stringify(message.payload)}`,
      );
    }

    if (isStreamClose(message.controlFlags)) {
      procStream.incoming.end();
      await Promise.all(procStream.openPromises);
      procStream.outgoing.end();
    }
  };

  transport.addMessageListener(handler);
  return {
    services,
    async close() {
      transport.removeMessageListener(handler);
      for (const [_, stream] of streamMap) {
        stream.incoming.end();
        await Promise.all(stream.openPromises);
        stream.outgoing.end();
      }
    },
  };
}
