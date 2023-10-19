import { TObject } from '@sinclair/typebox';
import { Transport } from '../transport/types';
import { AnyService, Procedure, ValidProcType } from './builder';
import { Value } from '@sinclair/typebox/value';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import { OpaqueTransportMessage, TransportMessage } from '../transport/message';
import { ServiceContext, ServiceContextWithState } from './context';
import { log } from '../logging';

export interface Server<Services> {
  services: Services;
  close(): Promise<void>;
}

interface ProcStream {
  incoming: Pushable<TransportMessage>;
  outgoing: Pushable<TransportMessage>;
  doneCtx: Promise<unknown>;
}

export async function createServer<Services extends Record<string, AnyService>>(
  transport: Transport,
  services: Services,
  extendedContext?: Omit<ServiceContext, 'state'>,
): Promise<Server<Services>> {
  const contextMap: Map<
    AnyService,
    ServiceContextWithState<object>
  > = new Map();
  const streamMap: Map<string, ProcStream> = new Map();

  function getContext(service: AnyService) {
    const context = contextMap.get(service);

    if (!context) {
      const err = `No context found for ${service.name}`;
      log?.error(err);
      throw new Error(err);
    }

    return context;
  }

  for (const [serviceName, service] of Object.entries(services)) {
    // populate the context map
    contextMap.set(service, { ...extendedContext, state: service.state });

    // create streams for every stream procedure
    for (const [procedureName, proc] of Object.entries(service.procedures)) {
      const procedure = proc as Procedure<
        object,
        ValidProcType,
        TObject,
        TObject
      >;
      if (procedure.type === 'stream') {
        const incoming: ProcStream['incoming'] = pushable({ objectMode: true });
        const outgoing: ProcStream['outgoing'] = pushable({ objectMode: true });
        const procStream: ProcStream = {
          incoming,
          outgoing,
          doneCtx: Promise.all([
            // processing the actual procedure
            procedure.handler(getContext(service), incoming, outgoing),
            // sending outgoing messages back to client
            (async () => {
              for await (const response of outgoing) {
                transport.send(response);
              }
            })(),
          ]),
        };

        streamMap.set(`${serviceName}:${procedureName}`, procStream);
      }
    }
  }

  const handler = async (msg: OpaqueTransportMessage) => {
    if (msg.to !== 'SERVER') {
      return;
    }

    if (msg.serviceName in services) {
      const service = services[msg.serviceName];
      if (msg.procedureName in service.procedures) {
        const procedure = service.procedures[msg.procedureName] as Procedure<
          object,
          'stream' | 'rpc',
          TObject,
          TObject
        >;

        const inputMessage = msg as TransportMessage<
          (typeof procedure)['input']
        >;

        if (
          procedure.type === 'rpc' &&
          Value.Check(procedure.input, inputMessage.payload)
        ) {
          const response = await procedure.handler(
            getContext(service),
            inputMessage,
          );
          transport.send(response);
          return;
        } else if (
          procedure.type === 'stream' &&
          Value.Check(procedure.input, inputMessage.payload)
        ) {
          // async stream, push to associated stream. code above handles sending responses
          // back to the client
          const streams = streamMap.get(
            `${msg.serviceName}:${msg.procedureName}`,
          );
          if (!streams) {
            // this should never happen but log here if we get here
            return;
          }

          streams.incoming.push(inputMessage);
          return;
        } else {
          log?.error(
            `${transport.clientId} -- procedure ${msg.serviceName}.${msg.procedureName} received invalid payload: ${inputMessage.payload}`,
          );
        }
      }
    }

    log?.warn(
      `${transport.clientId} -- couldn't find a matching procedure for ${msg.serviceName}.${msg.procedureName}`,
    );
  };

  transport.addMessageListener(handler);
  return {
    services,
    async close() {
      // remove listener
      transport.removeMessageListener(handler);

      // end all existing streams
      for (const [_, stream] of streamMap) {
        stream.incoming.end();
        stream.outgoing.end();
        await stream.doneCtx;
      }
    },
  };
}
