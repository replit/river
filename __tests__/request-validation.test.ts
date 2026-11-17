import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import * as compiler from 'typebox/compile';
import { BinaryCodec } from '../codec';
import { DateType, Uint8ArrayType } from '../customSchemas';
import {
  createClient,
  createServer,
  createServiceSchema,
  INVALID_REQUEST_CODE,
  Ok,
  Procedure,
} from '../router';
import { createMockTransportNetwork } from '../testUtil/fixtures/mockTransport';

vi.mock('typebox/compile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('typebox/compile')>();

  return { ...actual, Compile: vi.fn(actual.Compile) };
});

const JsonValue = Type.Cyclic(
  {
    Value: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref('Value')),
      Type.Record(Type.String(), Type.Ref('Value')),
    ]),
  },
  'Value',
);

describe('compiled request validation', () => {
  let network: ReturnType<typeof createMockTransportNetwork>;

  beforeEach(() => {
    vi.clearAllMocks();
    network = createMockTransportNetwork({
      client: { codec: BinaryCodec },
      server: { codec: BinaryCodec },
    });
  });

  afterEach(async () => {
    await network.cleanup();
    vi.restoreAllMocks();
  });

  test('compiles a shared request schema once across procedures', async () => {
    const compile = vi.mocked(compiler.Compile);
    const requestInit = Type.Object({ value: JsonValue });
    const handler = vi.fn(async () => Ok(true));
    const services = {
      test: createServiceSchema().define({
        first: Procedure.rpc({
          requestInit,
          responseData: Type.Boolean(),
          handler,
        }),
        second: Procedure.rpc({
          requestInit,
          responseData: Type.Boolean(),
          handler,
        }),
      }),
    };
    createServer(network.getServerTransport(), services);
    const client = createClient<typeof services>(
      network.getClientTransport('client'),
      'SERVER',
    );
    const value = Array.from({ length: 1000 }, (_, i) => ({
      index: i,
      nested: [null, true, 'text', { n: i }],
    }));

    expect(await client.test.first.rpc({ value })).toEqual(Ok(true));
    expect(await client.test.second.rpc({ value })).toEqual(Ok(true));
    expect(await client.test.first.rpc({ value: null })).toEqual(Ok(true));
    expect(
      compile.mock.calls.filter(([schema]) => Object.is(schema, requestInit)),
    ).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  test('rejects malformed recursive input without invoking the handler', async () => {
    const handler = vi.fn(async () => Ok(true));
    const services = {
      test: createServiceSchema().define({
        validate: Procedure.rpc({
          requestInit: Type.Object({ value: JsonValue }),
          responseData: Type.Boolean(),
          handler,
        }),
      }),
    };
    createServer(network.getServerTransport(), services);
    const client = createClient<typeof services>(
      network.getClientTransport('client'),
      'SERVER',
    );

    expect(
      await client.test.validate.rpc({ value: { nested: [1, null] } }),
    ).toEqual(Ok(true));
    // @ts-expect-error Deliberately exercise invalid input at the wire boundary.
    const result = await client.test.validate.rpc({});
    expect(result).toMatchObject({
      ok: false,
      payload: { code: INVALID_REQUEST_CODE },
    });
    // @ts-expect-error Bigints are not JSON values.
    const nested = await client.test.validate.rpc({ value: { nested: [1n] } });
    expect(nested).toMatchObject({
      ok: false,
      payload: { code: INVALID_REQUEST_CODE },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('preserves custom byte and date refinements', async () => {
    const services = {
      test: createServiceSchema().define({
        validate: Procedure.rpc({
          requestInit: Type.Object({
            bytes: Uint8ArrayType({ minByteLength: 2, maxByteLength: 3 }),
            date: DateType({ minimumTimestamp: 1000, maximumTimestamp: 2000 }),
          }),
          responseData: Type.Boolean(),
          handler: async () => Ok(true),
        }),
      }),
    };
    createServer(network.getServerTransport(), services);
    const client = createClient<typeof services>(
      network.getClientTransport('client'),
      'SERVER',
    );

    expect(
      await client.test.validate.rpc({
        bytes: new Uint8Array(2),
        date: new Date(1500),
      }),
    ).toEqual(Ok(true));
    for (const input of [
      { bytes: new Uint8Array(1), date: new Date(1500) },
      { bytes: new Uint8Array(4), date: new Date(1500) },
      { bytes: new Uint8Array(2), date: new Date(999) },
      { bytes: new Uint8Array(2), date: new Date(2001) },
    ]) {
      expect(await client.test.validate.rpc(input)).toMatchObject({
        ok: false,
        payload: { code: INVALID_REQUEST_CODE },
      });
    }
  });

  test('reuses validation for streamed request data', async () => {
    const compile = vi.mocked(compiler.Compile);
    const requestInit = Type.Object({});
    const requestData = Type.Object({ nested: JsonValue });
    const services = {
      test: createServiceSchema().define({
        count: Procedure.upload({
          requestInit,
          requestData,
          responseData: Type.Number(),
          handler: async ({ reqReadable }) => {
            let count = 0;
            for await (const result of reqReadable) {
              expect(result.ok).toBe(true);
              count++;
            }

            return Ok(count);
          },
        }),
      }),
    };
    createServer(network.getServerTransport(), services);
    const client = createClient<typeof services>(
      network.getClientTransport('client'),
      'SERVER',
    );
    const { reqWritable, finalize } = client.test.count.upload({});
    reqWritable.write({ nested: [null, 1] });
    reqWritable.write({ nested: ['text', true] });
    reqWritable.close();

    expect(await finalize()).toEqual(Ok(2));
    expect(
      compile.mock.calls.filter(([schema]) => Object.is(schema, requestInit)),
    ).toHaveLength(1);
    expect(
      compile.mock.calls.filter(([schema]) => Object.is(schema, requestData)),
    ).toHaveLength(1);
  });
});
