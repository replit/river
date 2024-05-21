import { assert, describe, expect, test } from 'vitest';
import { Procedure } from '../router/procedures';
import { ServiceSchema } from '../router/services';
import { Type } from '@sinclair/typebox';
import { createServer } from '../router/server';
import { Connection, ClientTransport, ServerTransport } from '../transport';
import { createClient } from '../router/client';
import {
  Err,
  Ok,
  Output,
  ResultUnwrapErr,
  ResultUnwrapOk,
} from '../router/result';
import { TestServiceSchema } from './fixtures/services';
import { getIteratorFromStream, iterNext } from '../util/testHelpers';

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
    const services = {
      a: StupidlyLargeServiceSchema,
      b: StupidlyLargeServiceSchema,
      c: StupidlyLargeServiceSchema,
      d: StupidlyLargeServiceSchema,
      e: StupidlyLargeServiceSchema,
      f: StupidlyLargeServiceSchema,
      g: StupidlyLargeServiceSchema,
      h: StupidlyLargeServiceSchema,
      i: StupidlyLargeServiceSchema,
      j: StupidlyLargeServiceSchema,
      k: StupidlyLargeServiceSchema,
      l: StupidlyLargeServiceSchema,
      m: StupidlyLargeServiceSchema,
      n: StupidlyLargeServiceSchema,
      o: StupidlyLargeServiceSchema,
      p: StupidlyLargeServiceSchema,
      q: StupidlyLargeServiceSchema,
      r: StupidlyLargeServiceSchema,
      s: StupidlyLargeServiceSchema,
      t: StupidlyLargeServiceSchema,
      u: StupidlyLargeServiceSchema,
      v: StupidlyLargeServiceSchema,
      w: StupidlyLargeServiceSchema,
      x: StupidlyLargeServiceSchema,
      y: StupidlyLargeServiceSchema,
      z: StupidlyLargeServiceSchema,
      a1: StupidlyLargeServiceSchema,
      b1: StupidlyLargeServiceSchema,
      c1: StupidlyLargeServiceSchema,
      d1: StupidlyLargeServiceSchema,
      e1: StupidlyLargeServiceSchema,
      f1: StupidlyLargeServiceSchema,
      g1: StupidlyLargeServiceSchema,
      h1: StupidlyLargeServiceSchema,
      i1: StupidlyLargeServiceSchema,
      j1: StupidlyLargeServiceSchema,
      k1: StupidlyLargeServiceSchema,
      l1: StupidlyLargeServiceSchema,
      m1: StupidlyLargeServiceSchema,
      n1: StupidlyLargeServiceSchema,
      o1: StupidlyLargeServiceSchema,
      p1: StupidlyLargeServiceSchema,
      q1: StupidlyLargeServiceSchema,
      r1: StupidlyLargeServiceSchema,
      s1: StupidlyLargeServiceSchema,
      t1: StupidlyLargeServiceSchema,
      u1: StupidlyLargeServiceSchema,
      v1: StupidlyLargeServiceSchema,
      w1: StupidlyLargeServiceSchema,
      x1: StupidlyLargeServiceSchema,
      y1: StupidlyLargeServiceSchema,
      z1: StupidlyLargeServiceSchema,
      test: TestServiceSchema,
    };
    const server = createServer(new MockServerTransport('SERVER'), services);

    const client = createClient<typeof services>(
      new MockClientTransport('client'),
      'SERVER',
      { eagerlyConnect: false },
    );

    expect(client.d.f59.rpc({ a: 0 })).toBeTruthy();
    expect(client.a.f2.rpc({ c: 'abc' })).toBeTruthy();
    expect(client.test.add.rpc({ n: 1 })).toBeTruthy();
    expect(client.z1.f40.rpc({ a: 1 })).toBeTruthy();
    expect(server).toBeTruthy();
    expect(client).toBeTruthy();
  });
});

describe('Output<> type', () => {
  const services = {
    test: ServiceSchema.define({
      rpc: Procedure.rpc({
        input: Type.Object({ n: Type.Number() }),
        output: Type.Object({ n: Type.Number() }),
        async handler(_, { n }) {
          return Ok({ n });
        },
      }),
      stream: Procedure.stream({
        input: Type.Object({ n: Type.Number() }),
        output: Type.Object({ n: Type.Number() }),
        async handler(_c, _in, output) {
          output.push(Ok({ n: 1 }));
        },
      }),
      subscription: Procedure.subscription({
        input: Type.Object({ n: Type.Number() }),
        output: Type.Object({ n: Type.Number() }),
        async handler(_c, _in, output) {
          output.push(Ok({ n: 1 }));
        },
      }),
      upload: Procedure.upload({
        input: Type.Object({ n: Type.Number() }),
        output: Type.Object({ n: Type.Number() }),
        async handler(_c, _in) {
          return Ok({ n: 1 });
        },
      }),
    }),
  };
  createServer(new MockServerTransport('SERVER'), services);
  const client = createClient<typeof services>(
    new MockClientTransport('client'),
    'SERVER',
    { eagerlyConnect: false },
  );

  test('it unwraps rpc outputs correctly', async () => {
    // Given
    function acceptOutput(output: Output<typeof client, 'test', 'rpc'>) {
      return output;
    }

    // Then
    void client.test.rpc.rpc({ n: 1 }).then(acceptOutput);
    expect(client).toBeTruthy();
  });

  test('it unwraps stream outputs correctly', async () => {
    // Given
    function acceptOutput(output: Output<typeof client, 'test', 'stream'>) {
      return output;
    }

    // Then
    void client.test.stream
      .stream()
      .then(([_in, outputReader, _close]) =>
        iterNext(getIteratorFromStream(outputReader)),
      )
      .then(acceptOutput);
    expect(client).toBeTruthy();
  });

  test('it unwraps subscription outputs correctly', async () => {
    // Given
    function acceptOutput(
      output: Output<typeof client, 'test', 'subscription'>,
    ) {
      return output;
    }

    // Then
    void client.test.subscription
      .subscribe({ n: 1 })
      .then(([outputReader, _close]) =>
        iterNext(getIteratorFromStream(outputReader)),
      )
      .then(acceptOutput);
    expect(client).toBeTruthy();
  });

  test('it unwraps upload outputs correctly', async () => {
    // Given
    function acceptOutput(output: Output<typeof client, 'test', 'upload'>) {
      return output;
    }

    // Then
    void client.test.upload
      .upload()
      .then(([_input, result]) => result)
      .then(acceptOutput);
    expect(client).toBeTruthy();
  });
});

describe('ResultUwrap types', () => {
  test('it unwraps Ok correctly', () => {
    // Given
    const result = Ok({ hello: 'world' });

    // When
    function acceptOk(payload: ResultUnwrapOk<typeof result>) {
      return payload;
    }

    // Then
    assert(result.ok);
    expect(acceptOk(result.payload)).toEqual({ hello: 'world' });
  });

  test('it unwraps Err correctly', () => {
    // Given
    const result = Err({ hello: 'world' });

    // When
    function acceptErr(payload: ResultUnwrapErr<typeof result>) {
      return payload;
    }

    // Then
    assert(!result.ok);
    expect(acceptErr(result.payload)).toEqual({ hello: 'world' });
  });
});
