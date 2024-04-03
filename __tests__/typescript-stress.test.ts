import { describe, expect, test } from 'vitest';
import { Procedure } from '../router/procedures';
import { ServiceSchema } from '../router/services';
import { Type } from '@sinclair/typebox';
import { createServer } from '../router/server';
import { Connection, ClientTransport, ServerTransport } from '../transport';
import { createClient } from '../router/client';
import { Ok } from '../router/result';
import { TestServiceSchema } from './fixtures/services';

const input = Type.Union([
  Type.Object({ a: Type.Number() }),
  Type.Object({ c: Type.String() }),
]);
const output = Type.Object({ b: Type.Union([Type.Number(), Type.String()]) });
const errors = Type.Union([
  Type.Object({
    code: Type.Literal('ERROR1'),
    message: Type.String(),
  }),
  Type.Object({
    code: Type.Literal('ERROR2'),
    message: Type.String(),
  }),
]);

const fnBody = Procedure.rpc<
  Record<string, never>,
  typeof input,
  typeof output,
  typeof errors
>({
  input,
  output,
  errors,
  async handler(_state, msg) {
    if ('c' in msg) {
      return Ok({ b: msg.c });
    } else {
      return Ok({ b: msg.a });
    }
  },
});

// typescript is limited to max 50 constraints
// see: https://github.com/microsoft/TypeScript/issues/33541
// we should be able to support more than that due to how we make services
const StupidlyLargeServiceSchema = ServiceSchema.define({
  f1: fnBody,
  f2: fnBody,
  f3: fnBody,
  f4: fnBody,
  f5: fnBody,
  f6: fnBody,
  f7: fnBody,
  f8: fnBody,
  f9: fnBody,
  f10: fnBody,
  f11: fnBody,
  f12: fnBody,
  f13: fnBody,
  f14: fnBody,
  f15: fnBody,
  f16: fnBody,
  f17: fnBody,
  f18: fnBody,
  f19: fnBody,
  f20: fnBody,
  f21: fnBody,
  f22: fnBody,
  f23: fnBody,
  f24: fnBody,
  f25: fnBody,
  f26: fnBody,
  f27: fnBody,
  f28: fnBody,
  f29: fnBody,
  f30: fnBody,
  f31: fnBody,
  f32: fnBody,
  f33: fnBody,
  f34: fnBody,
  f35: fnBody,
  f36: fnBody,
  f37: fnBody,
  f38: fnBody,
  f39: fnBody,
  f40: fnBody,
  f41: fnBody,
  f42: fnBody,
  f43: fnBody,
  f44: fnBody,
  f45: fnBody,
  f46: fnBody,
  f47: fnBody,
  f48: fnBody,
  f49: fnBody,
  f50: fnBody,
  f51: fnBody,
  f52: fnBody,
  f53: fnBody,
  f54: fnBody,
  f55: fnBody,
  f56: fnBody,
  f57: fnBody,
  f58: fnBody,
  f59: fnBody,
});

// mock transport
export class MockClientTransport extends ClientTransport<Connection> {
  protected async createNewOutgoingConnection(
    _to: string,
  ): Promise<Connection> {
    throw new Error('Method not implemented.');
  }
}

export class MockServerTransport extends ServerTransport<Connection> {}

describe("ensure typescript doesn't give up trying to infer the types for large services", () => {
  test('service with many procedures hits typescript limit', () => {
    expect(StupidlyLargeServiceSchema.serialize()).toBeTruthy();
  });

  test('server client should support many services with many procedures', () => {
    const server = createServer(new MockServerTransport('SERVER'), {
      a: StupidlyLargeServiceSchema,
      b: StupidlyLargeServiceSchema,
      c: StupidlyLargeServiceSchema,
      d: StupidlyLargeServiceSchema,
      test: TestServiceSchema,
    });

    const client = createClient<typeof server>(
      new MockClientTransport('client'),
      'SERVER',
      false,
    );

    expect(client.d.f59.rpc({ a: 0 })).toBeTruthy();
    expect(client.a.f2.rpc({ c: 'abc' })).toBeTruthy();
    expect(client.test.add.rpc({ n: 1 })).toBeTruthy();
    expect(server).toBeTruthy();
    expect(client).toBeTruthy();
  });
});
