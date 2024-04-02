import { describe, expect, test } from 'vitest';
import { Procedure, ServiceBuilder, serializeService } from '../router/builder';
import { Type } from '@sinclair/typebox';
import { createServer } from '../router/server';
import { Connection, ClientTransport, ServerTransport } from '../transport';
import { createClient } from '../router/client';
import { Ok } from '../router/result';
import { buildServiceDefs } from '../router/defs';
import { TestServiceConstructor } from './fixtures/services';

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

const fnBody: Procedure<
  object,
  'rpc',
  typeof input,
  typeof output,
  typeof errors
> = {
  type: 'rpc',
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
};

// typescript is limited to max 50 constraints
// see: https://github.com/microsoft/TypeScript/issues/33541
export const StupidlyLargeService = <Name extends string>(name: Name) =>
  ServiceBuilder.create(name)
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
    expect(serializeService(StupidlyLargeService('test'))).toBeTruthy();
  });

  test('server client should support many services with many procedures', () => {
    const serviceDefs = buildServiceDefs([
      StupidlyLargeService('a'),
      StupidlyLargeService('b'),
      StupidlyLargeService('c'),
      StupidlyLargeService('d'),
      StupidlyLargeService('e'),
      StupidlyLargeService('f'),
      StupidlyLargeService('g'),
      StupidlyLargeService('h'),
      StupidlyLargeService('i'),
      StupidlyLargeService('j'),
      StupidlyLargeService('k'),
      StupidlyLargeService('l'),
      StupidlyLargeService('m'),
      StupidlyLargeService('n'),
      StupidlyLargeService('o'),
      StupidlyLargeService('p'),
      StupidlyLargeService('q'),
      StupidlyLargeService('r'),
      StupidlyLargeService('s'),
      StupidlyLargeService('t'),
      StupidlyLargeService('u'),
      StupidlyLargeService('v'),
      StupidlyLargeService('w'),
      StupidlyLargeService('x'),
      StupidlyLargeService('y'),
      StupidlyLargeService('z'),
      StupidlyLargeService('a1'),
      StupidlyLargeService('b1'),
      StupidlyLargeService('c1'),
      StupidlyLargeService('d1'),
      StupidlyLargeService('e1'),
      StupidlyLargeService('f1'),
      StupidlyLargeService('g1'),
      StupidlyLargeService('h1'),
      StupidlyLargeService('i1'),
      StupidlyLargeService('j1'),
      StupidlyLargeService('k1'),
      StupidlyLargeService('l1'),
      StupidlyLargeService('m1'),
      StupidlyLargeService('n1'),
      StupidlyLargeService('o1'),
      StupidlyLargeService('p1'),
      StupidlyLargeService('q1'),
      StupidlyLargeService('r1'),
      StupidlyLargeService('s1'),
      StupidlyLargeService('t1'),
      StupidlyLargeService('u1'),
      StupidlyLargeService('v1'),
      StupidlyLargeService('w1'),
      StupidlyLargeService('x1'),
      StupidlyLargeService('y1'),
      StupidlyLargeService('z1'),
      TestServiceConstructor(),
    ]);

    const server = createServer(new MockServerTransport('SERVER'), serviceDefs);
    const client = createClient<typeof server>(
      new MockClientTransport('client'),
      'SERVER',
      false,
    );
    expect(client.d.f48.rpc({ a: 0 })).toBeTruthy();
    expect(client.a.f2.rpc({ c: 'abc' })).toBeTruthy();
    expect(client.test.add.rpc({ n: 1 })).toBeTruthy();
    expect(client.z1.f40.rpc({ a: 1 })).toBeTruthy();
    expect(server).toBeTruthy();
    expect(client).toBeTruthy();
  });
});
