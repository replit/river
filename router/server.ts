import { Static, TObject } from '@sinclair/typebox';
import { Transport } from '../transport/types';
import { Procedure, Service } from './builder';
import { Value } from '@sinclair/typebox/value';
import { Pushable, pushable } from 'it-pushable';
import { OpaqueTransportMessage, TransportMessage } from '../transport/message';

export interface Server<Services extends Record<string, Service>> {
  services: Services;
  close(): Promise<void>;
}

interface ProcStream {
  incoming: AsyncIterable<Record<string, unknown>>;
  outgoing: Pushable<Record<string, unknown>>;
}

export async function createServer<Services extends Record<string, Service>>(
  transport: Transport,
  services: Services,
): Promise<Server<Services>> {
  // create streams for every stream procedure
  const streamMap: Map<string, ProcStream> = new Map();
  for (const [serviceName, service] of Object.entries(services)) {
    for (const [procedureName, proc] of Object.entries(service.procedures)) {
      const procedure = proc as Procedure<object, 'stream' | 'rpc', TObject, TObject>;
      if (procedure.type === 'stream') {
        const procStream: ProcStream = {
          incoming: pushable<Record<string, unknown>>({ objectMode: true }),
          outgoing: pushable<Record<string, unknown>>({ objectMode: true }),
        };

        streamMap.set(`${serviceName}:${procedureName}`, procStream);
        const responseStream = await procedure.handler(
          service.state,
          procStream.incoming,
          procStream.outgoing,
        );
        for await (const response of responseStream) {
          transport.send(response);
        }
      }
    }
  }

  const handler = async (msg: OpaqueTransportMessage) => {
    // TODO: log msgs received
    if (msg.to !== 'server') {
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

        if (procedure.type === 'rpc' && Value.Check(procedure.input, msg.payload)) {
          // synchronous rpc
          const response = await procedure.handler(
            service.state,
            msg as Static<TransportMessage<(typeof procedure)['input']>>,
          );

          transport.send(response);
          return;
        } else if (procedure.type === 'stream' && Value.Check(procedure.input, msg.payload)) {
          // async stream, push to associated stream. code above handles sending responses
          // back to the client
          const streams = streamMap.get(`${msg.serviceName}:${msg.procedureName}`);
          if (!streams) {
            // this should never happen but log here if we get here
            return;
          }

          streams.outgoing.push(msg.payload);
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
      streamMap.forEach((stream) => stream.end());
      transport.removeMessageListener(handler);
    },
  };
}
