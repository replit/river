import { describe, expect, test } from 'vitest';
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
  unwrap,
} from '../router/result';
import { TestServiceSchema } from './fixtures/services';
import { getIteratorFromStream, iterNext } from '../util/testHelpers';
import {
  createClientHandshakeOptions,
  createServerHandshakeOptions,
} from '../router/handshake';

const requestData = Type.Union([
  Type.Object({ a: Type.Number() }),
  Type.Object({ c: Type.String() }),
]);
const responseData = Type.Object({
  b: Type.Union([Type.Number(), Type.String()]),
});
const responseError = Type.Union([
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
  typeof requestData,
  typeof responseData,
  typeof responseError
>({
  requestInit: requestData,
  responseData,
  responseError,
  async handler({ reqInit }) {
    if ('c' in reqInit) {
      return Ok({ b: reqInit.c });
    } else {
      return Ok({ b: reqInit.a });
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

const services = {
  test: ServiceSchema.define({
    rpc: Procedure.rpc({
      requestInit: Type.Object({ n: Type.Number() }),
      responseData: Type.Object({ n: Type.Number() }),
      async handler({ reqInit: { n } }) {
        return Ok({ n });
      },
    }),
    stream: Procedure.stream({
      requestInit: Type.Object({}),
      requestData: Type.Object({ n: Type.Number() }),
      responseData: Type.Object({ n: Type.Number() }),
      async handler({ resWriter }) {
        resWriter.write(Ok({ n: 1 }));
      },
    }),
    subscription: Procedure.subscription({
      requestInit: Type.Object({ n: Type.Number() }),
      responseData: Type.Object({ n: Type.Number() }),
      async handler({ resWriter }) {
        resWriter.write(Ok({ n: 1 }));
      },
    }),
    upload: Procedure.upload({
      requestInit: Type.Object({}),
      requestData: Type.Object({ n: Type.Number() }),
      responseData: Type.Object({ n: Type.Number() }),
      async handler() {
        return Ok({ n: 1 });
      },
    }),
  }),
};

describe('Output<> type', () => {
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
    const { resReader } = client.test.stream.stream({});
    void iterNext(getIteratorFromStream(resReader))
      .then(unwrap)
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
    const { resReader } = client.test.subscription.subscribe({ n: 1 });
    void iterNext(getIteratorFromStream(resReader))
      .then(unwrap)
      .then(acceptOutput);

    expect(client).toBeTruthy();
  });

  test('it unwraps upload outputs correctly', async () => {
    // Given
    function acceptOutput(output: Output<typeof client, 'test', 'upload'>) {
      return output;
    }

    // Then
    const { finalize } = client.test.upload.upload({});
    void finalize().then(acceptOutput);

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
    expect(result.ok).toBe(true);
    expect(acceptOk(result.payload)).toEqual({ hello: 'world' });
  });

  test('it unwraps Err correctly', () => {
    // Given
    const result = Err({ code: 'world', message: 'hello' });

    // When
    function acceptErr(payload: ResultUnwrapErr<typeof result>) {
      return payload;
    }

    // Then
    expect(result.ok).toBe(false);
    expect(acceptErr(result.payload)).toEqual({
      code: 'world',
      message: 'hello',
    });
  });
});

describe('Handshake', () => {
  test('custom handhshake types should work', () => {
    const schema = Type.Object({ token: Type.String() });
    createClient<typeof services>(new MockClientTransport('client'), 'SERVER', {
      eagerlyConnect: false,
      handshakeOptions: createClientHandshakeOptions(schema, () => ({
        token: '123',
      })),
    });

    createServer(new MockServerTransport('SERVER'), services, {
      handshakeOptions: createServerHandshakeOptions(
        schema,
        (metadata, _prev) => {
          if (metadata.token !== '123') {
            return false;
          }

          return {};
        },
      ),
    });
  });
});
