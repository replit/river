import { assert, describe, expect, test } from 'vitest';
import { Procedure } from '../router/procedures';
import { createServiceSchema } from '../router/services';
import { Type } from '@sinclair/typebox';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import {
  Err,
  Ok,
  ResponseData,
  ResultUnwrapErr,
  ResultUnwrapOk,
  unwrapOrThrow,
} from '../router/result';
import {
  testContext,
  TestServiceWithContextSchema,
} from '../testUtil/fixtures/services';
import { readNextResult } from '../testUtil';
import {
  createClientHandshakeOptions,
  createServerHandshakeOptions,
} from '../router/handshake';
import { flattenErrorType, ProcedureErrorSchemaType } from '../router/errors';
import { ReadableImpl } from '../router/streams';
import { createMockTransportNetwork } from '../testUtil/fixtures/mockTransport';

const requestData = Type.Union([
  Type.Object({ a: Type.Number() }),
  Type.Object({ c: Type.String() }),
  Type.Object({ d: Type.Number() }),
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
  typeof testContext,
  {
    db: string;
  },
  typeof requestData,
  typeof responseData,
  typeof responseError
>({
  requestInit: requestData,
  responseData,
  responseError,
  async handler({ reqInit, ctx }) {
    if ('c' in reqInit) {
      return Ok({ b: reqInit.c });
    } else if ('d' in reqInit) {
      return Ok({ b: ctx.add(reqInit.d, reqInit.d) });
    } else {
      return Ok({ b: reqInit.a });
    }
  },
});

// typescript is limited to max 50 constraints
// see: https://github.com/microsoft/TypeScript/issues/33541
// we should be able to support more than that due to how we make services
const StupidlyLargeServiceSchema = createServiceSchema(testContext).define({
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
      test: TestServiceWithContextSchema,
    };

    const mockTransportNetwork = createMockTransportNetwork();
    const server = createServer(
      mockTransportNetwork.getServerTransport(),
      services,
      {
        extendedContext: testContext,
      },
    );

    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
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

  test('service with context should be able to access context in procedures', async () => {
    const services = {
      a: StupidlyLargeServiceSchema,
      b: StupidlyLargeServiceSchema,
    };
    const mockTransportNetwork = createMockTransportNetwork();
    const server = createServer(
      mockTransportNetwork.getServerTransport(),
      services,
      {
        extendedContext: testContext,
      },
    );

    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
      { eagerlyConnect: false },
    );

    const res = await client.a.f2.rpc({ d: 1 });
    assert(res.ok);
    expect(res.payload.b).toBe(2);

    const res2 = await client.b.f11.rpc({ d: 10 });
    assert(res2.ok);
    expect(res2.payload.b).toBe(20);

    expect(server).toBeTruthy();
    expect(client).toBeTruthy();
  });
});

const services = {
  test: createServiceSchema().define({
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
      async handler({ resWritable }) {
        resWritable.write(Ok({ n: 1 }));
      },
    }),
    subscription: Procedure.subscription({
      requestInit: Type.Object({ n: Type.Number() }),
      responseData: Type.Object({ n: Type.Number() }),
      async handler({ resWritable }) {
        resWritable.write(Ok({ n: 1 }));
      },
    }),
    upload: Procedure.upload({
      requestInit: Type.Object({}),
      requestData: Type.Object({ n: Type.Number() }),
      responseData: Type.Object({ n: Type.Number() }),
      responseError: flattenErrorType(
        Type.Union([
          Type.Object({
            code: Type.Literal('ERROR1'),
            message: Type.String(),
          }),
          Type.Object({
            code: Type.Literal('ERROR2'),
            message: Type.String(),
          }),
        ]),
      ),
      async handler({ ctx, reqReadable }) {
        for await (const { ok, payload } of reqReadable) {
          if (!ok) {
            return ctx.cancel();
          }

          if (payload.n === 1) {
            return Err({ code: 'ERROR1', message: 'n is 1' });
          }

          if (payload.n === 2) {
            return Err({ code: 'ERROR2', message: 'n is 2' });
          }
        }

        return Ok({ n: 1 });
      },
    }),
  }),
};

describe('ResponseData<> type', () => {
  const mockTransportNetwork = createMockTransportNetwork();

  createServer(mockTransportNetwork.getServerTransport(), services);
  const client = createClient<typeof services>(
    mockTransportNetwork.getClientTransport('client'),
    'SERVER',
    { eagerlyConnect: false },
  );

  test('it unwraps rpc response data correctly', async () => {
    // Given
    function acceptResponse(
      response: ResponseData<typeof client, 'test', 'rpc'>,
    ) {
      return response;
    }

    // Then
    void client.test.rpc.rpc({ n: 1 }).then(acceptResponse);
    expect(client).toBeTruthy();
  });

  test('it unwraps stream response data correctly', async () => {
    // Given
    function acceptResponse(
      response: ResponseData<typeof client, 'test', 'stream'>,
    ) {
      return response;
    }

    // Then
    const { resReadable } = client.test.stream.stream({});
    void readNextResult(resReadable).then(unwrapOrThrow).then(acceptResponse);
    expect(client).toBeTruthy();
  });

  test('it unwraps subscription response data correctly', async () => {
    // Given
    function acceptResponse(
      response: ResponseData<typeof client, 'test', 'subscription'>,
    ) {
      return response;
    }

    // Then
    const { resReadable } = client.test.subscription.subscribe({ n: 1 });
    void readNextResult(resReadable).then(unwrapOrThrow).then(acceptResponse);

    expect(client).toBeTruthy();
  });

  test('it unwraps upload response data correctly', async () => {
    // Given
    function acceptResponse(
      response: ResponseData<typeof client, 'test', 'upload'>,
    ) {
      return response;
    }

    // Then
    const { finalize } = client.test.upload.upload({});
    void finalize().then(acceptResponse);

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
    const mockTransportNetwork = createMockTransportNetwork();
    createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
      {
        eagerlyConnect: false,
        handshakeOptions: createClientHandshakeOptions(schema, () => ({
          token: '123',
        })),
      },
    );

    createServer(mockTransportNetwork.getServerTransport(), services, {
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

describe('Procedure error schema', () => {
  function acceptErrorSchema(errorSchema: ProcedureErrorSchemaType) {
    return errorSchema;
  }

  describe('allowed', () => {
    test('object', () => {
      acceptErrorSchema(
        Type.Object({
          code: Type.Literal('1'),
          message: Type.String(),
        }),
      );
    });

    test('union of object', () => {
      acceptErrorSchema(
        Type.Union([
          Type.Object({
            code: Type.Literal('1'),
            message: Type.String(),
          }),
          Type.Object({
            code: Type.Literal('2'),
            message: Type.String(),
          }),
        ]),
      );
    });

    test('union of union', () => {
      acceptErrorSchema(
        flattenErrorType(
          Type.Union([
            Type.Union([
              Type.Object({
                code: Type.Literal('1'),
                message: Type.String(),
              }),
              Type.Object({
                code: Type.Literal('2'),
                message: Type.String(),
              }),
            ]),
            Type.Union([
              Type.Object({
                code: Type.Literal('3'),
                message: Type.String(),
              }),
              Type.Object({
                code: Type.Literal('4'),
                message: Type.String(),
              }),
            ]),
          ]),
        ),
      );
    });

    test('union of object and union', () => {
      acceptErrorSchema(
        flattenErrorType(
          Type.Union([
            Type.Object({
              code: Type.Literal('1'),
              message: Type.String(),
            }),
            Type.Union([
              Type.Object({
                code: Type.Literal('2'),
                message: Type.String(),
              }),
              Type.Object({
                code: Type.Literal('3'),
                message: Type.String(),
              }),
            ]),
          ]),
        ),
      );
    });

    test('deeeeep nesting', () => {
      acceptErrorSchema(
        flattenErrorType(
          Type.Union([
            Type.Object({
              code: Type.Literal('1'),
              message: Type.String(),
            }),
            Type.Union([
              Type.Object({
                code: Type.Literal('2'),
                message: Type.String(),
              }),
              Type.Union([
                Type.Object({
                  code: Type.Literal('3'),
                  message: Type.String(),
                }),
                Type.Union([
                  Type.Object({
                    code: Type.Literal('4'),
                    message: Type.String(),
                  }),
                  Type.Object({
                    code: Type.Literal('5'),
                    message: Type.String(),
                  }),
                ]),
              ]),
            ]),
          ]),
        ),
      );
    });

    test('mixed bag, union of object, unions, "union of unions", and "union of union and object" (I think)', () => {
      acceptErrorSchema(
        flattenErrorType(
          Type.Union([
            Type.Object({
              code: Type.Literal('1'),
              message: Type.String(),
            }),
            Type.Union([
              Type.Object({
                code: Type.Literal('2'),
                message: Type.String(),
              }),
              Type.Object({
                code: Type.Literal('3'),
                message: Type.String(),
              }),
            ]),
            Type.Union([
              Type.Union([
                Type.Object({
                  code: Type.Literal('4'),
                  message: Type.String(),
                }),
                Type.Object({
                  code: Type.Literal('5'),
                  message: Type.String(),
                }),
              ]),
              Type.Union([
                Type.Object({
                  code: Type.Literal('6'),
                  message: Type.String(),
                }),
                Type.Object({
                  code: Type.Literal('7'),
                  message: Type.String(),
                }),
              ]),
            ]),
            Type.Union([
              Type.Object({
                code: Type.Literal('4'),
                message: Type.String(),
              }),
              Type.Union([
                Type.Object({
                  code: Type.Literal('4'),
                  message: Type.String(),
                }),
                Type.Object({
                  code: Type.Literal('5'),
                  message: Type.String(),
                }),
              ]),
              Type.Union([
                Type.Object({
                  code: Type.Literal('6'),
                  message: Type.String(),
                }),
                Type.Object({
                  code: Type.Literal('7'),
                  message: Type.String(),
                }),
              ]),
            ]),
          ]),
        ),
      );
    });
  });

  describe('fails', () => {
    test('fails when object has an invalid error shape', () => {
      acceptErrorSchema(
        // @ts-expect-error testing this
        Type.Object({
          NOTCODE: Type.Literal('1'),
          message: Type.String(),
        }),
      );

      acceptErrorSchema(
        // @ts-expect-error testing this
        Type.Union([
          Type.Object({
            code: Type.Literal('1'),
            message: Type.String(),
          }),
          Type.Object({
            NOTCODE: Type.Literal('2'),
            message: Type.String(),
          }),
        ]),
      );
    });

    test('fails on nested union without helper', () => {
      acceptErrorSchema(
        // @ts-expect-error testing this
        Type.Union([
          Type.Object({
            code: Type.Literal('1'),
            message: Type.String(),
          }),
          Type.Union([
            Type.Object({
              code: Type.Literal('2'),
              message: Type.String(),
            }),
            Type.Object({
              code: Type.Literal('3'),
              message: Type.String(),
            }),
          ]),
        ]),
      );
    });
  });
});

describe('Readable types', () => {
  // Skip, we're only testing types
  test.skip('should maintain result types', async () => {
    function acceptsErrors(_code: 'SOME_ERROR' | 'READABLE_BROKEN') {
      // pass
    }

    function acceptsSuccess(_success: 'SUCCESS') {
      // pass
    }

    const readable = new ReadableImpl<
      'SUCCESS',
      { code: 'SOME_ERROR'; message: string }
    >();
    for await (const value of readable) {
      if (value.ok) {
        acceptsSuccess(value.payload);
        continue;
      }

      acceptsErrors(value.payload.code);
    }
  });
});
