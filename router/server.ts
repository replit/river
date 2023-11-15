import { TObject } from '@sinclair/typebox';
import { Transport } from '../transport/types';
import { AnyService, Procedure, ValidProcType } from './builder';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import {
  OpaqueTransportMessage,
  TransportMessage,
  isStreamClose,
  isStreamOpen,
} from '../transport/message';
import { ServiceContext, ServiceContextWithState } from './context';
import { log } from '../logging';
import { Value } from '@sinclair/typebox/value';

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
  outgoing: Pushable<TransportMessage>;
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
  transport: Transport,
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

  const handler = async (msg: OpaqueTransportMessage) => {
    if (msg.to !== 'SERVER') {
      log?.info(
        `${transport.clientId} -- got msg with destination that isn't the server, ignoring`,
      );
      return;
    }

    if (!(msg.serviceName in services)) {
      log?.warn(
        `${transport.clientId} -- couldn't find service ${msg.serviceName}`,
      );
      return;
    }

    const service = services[msg.serviceName];
    const serviceContext = getContext(service);
    if (!(msg.procedureName in service.procedures)) {
      log?.warn(
        `${transport.clientId} -- couldn't find a matching procedure for ${msg.serviceName}.${msg.procedureName}`,
      );
      return;
    }

    const procedure = service.procedures[msg.procedureName] as Procedure<
      object,
      ValidProcType,
      TObject,
      TObject
    >;

    if (!Value.Check(procedure.input, msg.payload)) {
      log?.error(
        `${transport.clientId} -- procedure ${msg.serviceName}.${msg.procedureName} received invalid payload: ${msg.payload}`,
      );
      return;
    }

    const inputMessage = msg as TransportMessage<TObject>;
    if (isStreamOpen(inputMessage.controlFlags)) {
      const incoming: ProcStream['incoming'] = pushable({ objectMode: true });
      const outgoing: ProcStream['outgoing'] = pushable({ objectMode: true });
      const openPromises: Array<Promise<unknown>> = [
        // sending outgoing messages back to client
        (async () => {
          for await (const response of outgoing) {
            transport.send(response);
          }
        })(),
      ];

      // pump incoming message stream -> handler -> outgoing message stream
      if (procedure.type === 'stream') {
        openPromises.push(
          procedure.handler(serviceContext, incoming, outgoing),
        );
      } else if (procedure.type === 'rpc') {
        openPromises.push(
          (async () => {
            for await (const inputMessage of incoming) {
              const outputMessage = await procedure.handler(
                serviceContext,
                inputMessage,
              );
              outgoing.push(outputMessage);
            }
          })(),
        );
      }

      streamMap.set(`${msg.serviceName}.${msg.procedureName}:${msg.streamId}`, {
        incoming,
        outgoing,
        openPromises,
      });
    }

    const procStream = streamMap.get(
      `${msg.serviceName}.${msg.procedureName}:${msg.streamId}`,
    );
    if (!procStream) {
      log?.warn(
        `${transport.clientId} -- couldn't find a matching procedure stream for ${msg.serviceName}.${msg.procedureName}:${msg.streamId}`,
      );
      return;
    }

    procStream.incoming.push(inputMessage);
    if (isStreamClose(inputMessage.controlFlags)) {
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
