import { TObject } from '@sinclair/typebox';
import { Transport } from '../transport/types';
import { Procedure, Service, ValidProcType } from './builder';
import { Value } from '@sinclair/typebox/value';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import { OpaqueTransportMessage, TransportMessage } from '../transport/message';

export interface Server<Services> {
  services: Services;
  close(): Promise<void>;
}

interface ProcStream {
  incoming: Pushable<TransportMessage>;
  outgoing: Pushable<TransportMessage>;
  doneCtx: Promise<unknown>;
}

export async function createServer<Services extends Record<string, Service>>(
  transport: Transport,
  services: Services,
): Promise<Server<Services>> {
  // create streams for every stream procedure
  const streamMap: Map<string, ProcStream> = new Map();
  for (const [serviceName, service] of Object.entries(services)) {
    for (const [procedureName, proc] of Object.entries(service.procedures)) {
      const procedure = proc as Procedure<object, ValidProcType, TObject, TObject>;
      if (procedure.type === 'stream') {
        const incoming: ProcStream['incoming'] = pushable({ objectMode: true });
        const outgoing: ProcStream['outgoing'] = pushable({ objectMode: true });
        const procStream: ProcStream = {
          incoming,
          outgoing,
          doneCtx: Promise.all([
            // processing the actual procedure
            procedure.handler(service.state, incoming, outgoing),
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
    // TODO: log msgs received
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

        const inputMessage = msg as TransportMessage<(typeof procedure)['input']>;
        if (procedure.type === 'rpc' && Value.Check(procedure.input, inputMessage.payload)) {
          // synchronous rpc
          const response = await procedure.handler(service.state, inputMessage);
          transport.send(response);
          return;
        } else if (
          procedure.type === 'stream' &&
          Value.Check(procedure.input, inputMessage.payload)
        ) {
          // async stream, push to associated stream. code above handles sending responses
          // back to the client
          const streams = streamMap.get(`${msg.serviceName}:${msg.procedureName}`);
          if (!streams) {
            // this should never happen but log here if we get here
            return;
          }

          streams.incoming.push(inputMessage);
          return;
        } else {
          // TODO: log invalid payload
        }
      }
    }
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
