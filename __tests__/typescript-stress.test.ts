import { describe, expect, test } from 'vitest';
import { Procedure, ServiceBuilder, serializeService } from '../router/builder';
import { TObject, Type } from '@sinclair/typebox';
import { MessageId, OpaqueTransportMessage, reply } from '../transport/message';
import { createServer } from '../router/server';
import { Transport } from '../transport/types';
import { NaiveJsonCodec } from '../codec/json';
import { createClient } from '../router/client';

const fnBody: Procedure<{}, 'rpc', TObject, TObject> = {
  type: 'rpc',
  input: Type.Object({ a: Type.Number() }),
  output: Type.Object({ b: Type.Number() }),
  async handler(_state, msg) {
    return reply(msg, { b: msg.payload.a });
  },
};

// typescript is limited to max 50 constraints
// see: https://github.com/microsoft/TypeScript/issues/33541
const svc = () =>
  ServiceBuilder.create('test')
    .defineProcedure('f1', fnBody)
    .defineProcedure('f2', fnBody)
    .defineProcedure('f3', fnBody)
    .defineProcedure('f4', fnBody)
    .defineProcedure('f5', fnBody)
    .defineProcedure('f6', fnBody)
    .defineProcedure('f7', fnBody)
    .defineProcedure('f8', fnBody)
    .defineProcedure('f9', fnBody)
    .defineProcedure('f10', fnBody)
    .defineProcedure('f11', fnBody)
    .defineProcedure('f12', fnBody)
    .defineProcedure('f13', fnBody)
    .defineProcedure('f14', fnBody)
    .defineProcedure('f15', fnBody)
    .defineProcedure('f16', fnBody)
    .defineProcedure('f17', fnBody)
    .defineProcedure('f18', fnBody)
    .defineProcedure('f19', fnBody)
    .defineProcedure('f20', fnBody)
    .defineProcedure('f21', fnBody)
    .defineProcedure('f22', fnBody)
    .defineProcedure('f23', fnBody)
    .defineProcedure('f24', fnBody)
    .defineProcedure('f25', fnBody)
    .defineProcedure('f26', fnBody)
    .defineProcedure('f27', fnBody)
    .defineProcedure('f28', fnBody)
    .defineProcedure('f29', fnBody)
    .defineProcedure('f30', fnBody)
    .defineProcedure('f31', fnBody)
    .defineProcedure('f32', fnBody)
    .defineProcedure('f33', fnBody)
    .defineProcedure('f34', fnBody)
    .defineProcedure('f35', fnBody)
    .defineProcedure('f36', fnBody)
    .defineProcedure('f37', fnBody)
    .defineProcedure('f38', fnBody)
    .defineProcedure('f39', fnBody)
    .defineProcedure('f40', fnBody)
    .defineProcedure('f41', fnBody)
    .defineProcedure('f42', fnBody)
    .defineProcedure('f43', fnBody)
    .defineProcedure('f44', fnBody)
    .defineProcedure('f45', fnBody)
    .defineProcedure('f46', fnBody)
    .defineProcedure('f47', fnBody)
    .defineProcedure('f48', fnBody)
    .defineProcedure('f49', fnBody)
    .finalize();

// mock transport
export class MockTransport extends Transport {
  constructor(clientId: string) {
    super(NaiveJsonCodec, clientId);
  }

  async send(msg: OpaqueTransportMessage): Promise<MessageId> {
    const id = msg.id;
    return id;
  }

  async close() {}
}

describe("ensure typescript doesn't give up trying to infer the types for large services", () => {
  test('service with many procedures hits typescript limit', () => {
    expect(serializeService(svc())).toBeTruthy();
  });

  test('serverclient should support many services with many procedures', async () => {
    const listing = {
      a: svc(),
      b: svc(),
      c: svc(),
      d: svc(),
    };
    const server = await createServer(new MockTransport('SERVER'), listing);
    const client = createClient<typeof server>(new MockTransport('client'));
    expect(server).toBeTruthy();
    expect(client).toBeTruthy();
  });
});
