import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { Codec } from '../codec';
import { decode } from '@msgpack/msgpack';
import {
  assert,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from 'vitest';
import {
  CANCEL_CODE,
  Err,
  Ok,
  ProtoCodec,
  RiverErrorCode,
  UNCAUGHT_ERROR_CODE,
  createClient,
  createProtoService,
  createServer,
  isSerializedClientErrorResult,
  serde,
  withSerde,
  type AnyProtoService,
  type Middleware,
  type ProtobufHandlerContext,
} from '../protobuf';
import {
  TransportEnvelopeSchema,
  type TransportEnvelope,
} from '../protobuf/gen/transport_pb';
import {
  cleanupTransports,
  createPostTestCleanups,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import {
  CountRequestSchema,
  CountResponseSchema,
  EchoRequestSchema,
  EchoResponseSchema,
  TestService,
  type EchoRequest,
} from '../testUtil/fixtures/protobuf';
import {
  type TestSetupHelpers,
  transports,
} from '../testUtil/fixtures/transports';
import { ControlFlags } from '../transport/message';

const ProtoService = createProtoService();
const binary = { input: serde.binary, output: serde.binary };
const countOutput = serde.message(CountResponseSchema);

test('registration rejects invalid serdes and mismatched method kinds', () => {
  const unary = withSerde(TestService.method.echo, binary, (bytes) =>
    Ok(bytes),
  );
  expect(() =>
    ProtoService.define(TestService, {
      // @ts-expect-error A unary definition cannot occupy a server-streaming slot.
      countUp: unary,
    }),
  ).toThrow('serde handler kind does not match');
  expect(() =>
    ProtoService.define(TestService, {
      // @ts-expect-error Explicit input codecs must implement Codec.
      echo: withSerde({ input: {}, output: serde.binary }, (bytes) =>
        Ok(bytes),
      ),
    }),
  ).toThrow('invalid handler codec');
});

test('handler types come from each codec without changing typed callers', () => {
  interface Context {
    prefix: string;
  }

  interface State {
    calls: number;
  }

  interface Metadata {
    userId: string;
  }
  const Factory = createProtoService<Context, Metadata>();
  const input: Codec<{ name: string }, number> = {
    fromBuffer: () => ({ name: 'hello' }),
    toBuffer: () => new Uint8Array(),
  };
  const output: Codec<{ decoded: boolean }, { message?: string }> = {
    fromBuffer: () => ({ decoded: true }),
    toBuffer: () => new Uint8Array(),
  };
  Factory.define(
    TestService,
    {
      initializeState: (ctx: Context) => ({ calls: ctx.prefix.length }),
    },
    {
      echo: withSerde({ input, output }, (request, ctx) => {
        expectTypeOf(request).toEqualTypeOf<{ name: string }>();
        expectTypeOf(ctx).toEqualTypeOf<
          ProtobufHandlerContext<Context, State, Metadata>
        >();

        return Ok({ message: request.name });
      }),
      countUp: withSerde(binary, ({ request, ctx, resWritable }) => {
        expectTypeOf(request).toEqualTypeOf<Uint8Array>();
        expectTypeOf(ctx.state.calls).toEqualTypeOf<number>();
        resWritable.write(Ok(request));
        resWritable.close();
      }),
    },
  );
  Factory.define(
    TestService,
    {
      initializeState: (ctx) => ({ calls: ctx.prefix.length }),
    },
    {
      echo: (request, ctx) => {
        expectTypeOf(request).toEqualTypeOf<EchoRequest>();
        expectTypeOf(ctx.state.calls).toEqualTypeOf<number>();

        return Ok({ text: request.text });
      },
    },
  );
  const invalidCalls = () => {
    // @ts-expect-error The constructor must check the handler against its codecs.
    ProtoService.define(TestService, {
      echo: { input, output, handler: () => Ok(123) },
    });
    ProtoService.define(TestService, {
      echo: withSerde({ input, output }, (request) => {
        // @ts-expect-error Input values come from fromBuffer, not toBuffer.
        expectTypeOf(request).toEqualTypeOf<number>();

        return Ok({});
      }),
    });
    ProtoService.define(TestService, {
      // @ts-expect-error Output values must match the output encoder's input.
      echo: withSerde({ input, output }, () => Ok(123)),
    });
    const unary = withSerde(TestService.method.echo, binary, (bytes) =>
      Ok(bytes),
    );
    // @ts-expect-error A hoisted unary handler cannot implement a server stream.
    ProtoService.define(TestService, { countUp: unary });
    const echo = withSerde(
      TestService.method.echo,
      {
        input: serde.message(EchoRequestSchema),
        output: serde.message(EchoResponseSchema),
      },
      (request) => Ok({ text: request.text.toUpperCase() }),
    );
    // @ts-expect-error Changing the input requires checking the handler again.
    ProtoService.define(TestService, {
      echo: { ...echo, input: serde.binary },
    });
    // @ts-expect-error Changing the output requires checking the handler again.
    ProtoService.define(TestService, {
      echo: { ...echo, output: serde.binary },
    });
    // @ts-expect-error A replacement handler must be checked against the codecs.
    ProtoService.define(TestService, {
      echo: { ...echo, handler: () => Ok(123) },
    });
  };
  expectTypeOf(invalidCalls).toBeFunction();
});

describe.each(transports)('protobuf serdes ($name transport)', (transport) => {
  const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
  let setup: TestSetupHelpers;
  let sent: Array<TransportEnvelope>;
  beforeEach(async () => {
    sent = [];
    setup = await transport.setup({
      client: { codec: ProtoCodec },
      server: {
        codec: {
          ...ProtoCodec,
          toBuffer(message) {
            const bytes = ProtoCodec.toBuffer(message);
            sent.push(fromBinary(TransportEnvelopeSchema, bytes));

            return bytes;
          },
        },
      },
    });

    return async () => {
      try {
        await postTestCleanup();
      } finally {
        await setup.cleanup();
      }
    };
  });

  function start(
    service: AnyProtoService,
    middlewares: Array<Middleware> = [],
  ) {
    const clientTransport = setup.getClientTransport('client');
    const serverTransport = setup.getServerTransport();
    const server = createServer(serverTransport, [service], { middlewares });
    addPostTestCleanup(async () => {
      try {
        await waitFor(() => expect(server.streams.size).toBe(0));
      } finally {
        await cleanupTransports([clientTransport, serverTransport]);
        await server.close();
      }
    });
    const client = createClient(
      TestService,
      clientTransport,
      serverTransport.clientId,
    );

    return { client, server, serverTransport };
  }

  test('binary requests own only their payload and middleware receives protobuf messages', async () => {
    let requestBytes: Uint8Array | undefined;
    const seen: Array<unknown> = [];
    const service = ProtoService.define(TestService, {
      echo: withSerde(binary, (request) => {
        requestBytes = request;

        return Ok(request);
      }),
    });
    const middleware: Middleware = ({ reqInit, next }) => {
      seen.push(reqInit);
      next();
    };
    const { client } = start(service, [middleware, middleware]);

    await expect(client.echo({ text: 'payload' })).resolves.toEqual(
      Ok(create(EchoResponseSchema, { text: 'payload' })),
    );
    assert(requestBytes);
    expect(requestBytes.byteOffset).toBe(0);
    expect(requestBytes.buffer.byteLength).toBe(requestBytes.byteLength);
    expect(
      Buffer.compare(
        requestBytes,
        serde.message(EchoRequestSchema).toBuffer({ text: 'payload' }),
      ),
    ).toBe(0);
    expect(seen).toEqual([
      create(EchoRequestSchema, { text: 'payload' }),
      create(EchoRequestSchema, { text: 'payload' }),
    ]);
    expect(seen[0]).toBe(seen[1]);
  });

  test.each(['before', 'after'] as const)(
    'middleware added %s server creation sees the request before custom decoding',
    async (timing) => {
      const input: Codec<string> = {
        fromBuffer(bytes) {
          const { text } = fromBinary(EchoRequestSchema, bytes);
          bytes.fill(255);

          return text;
        },
        toBuffer: (text) => serde.message(EchoRequestSchema).toBuffer({ text }),
      };
      const service = ProtoService.define(TestService, {
        echo: withSerde(
          { input, output: serde.message(EchoResponseSchema) },
          (text) => Ok({ text }),
        ),
      });
      const seen: Array<unknown> = [];
      const middleware: Middleware = ({ reqInit, next }) => {
        seen.push(reqInit);
        next();
      };
      const middlewares: Array<Middleware> = [];
      if (timing === 'before') middlewares.push(middleware);
      const { client } = start(service, middlewares);
      if (timing === 'after') middlewares.push(middleware);

      await expect(client.echo({ text: 'original' })).resolves.toEqual(
        Ok(create(EchoResponseSchema, { text: 'original' })),
      );
      expect(seen).toEqual([create(EchoRequestSchema, { text: 'original' })]);
    },
  );

  test.each([
    { name: 'empty', text: '' },
    { name: 'small', text: 'hello' },
    { name: 'three-byte length prefix', text: 'x'.repeat(16_384) },
  ])('binary output matches typed wire bytes ($name)', async ({ text }) => {
    const response = create(EchoResponseSchema, { text });
    const encoded = serde.message(EchoResponseSchema).toBuffer(response);
    const backing = new Uint8Array(encoded.length + 2).fill(255);
    backing.set(encoded, 1);
    const { client, server, serverTransport } = start(
      ProtoService.define(TestService, { echo: () => Ok(response) }),
    );
    await expect(client.echo({})).resolves.toEqual(Ok(response));
    await server.close();
    const explicitServer = createServer(serverTransport, [
      ProtoService.define(TestService, {
        echo: withSerde(
          { input: serde.message(EchoRequestSchema), output: serde.binary },
          () => Ok(backing.subarray(1, -1)),
        ),
      }),
    ]);
    addPostTestCleanup(async () => {
      serverTransport.close();
      await explicitServer.close();
    });
    await expect(client.echo({})).resolves.toEqual(Ok(response));

    const frames = sent.filter(
      (frame) => frame.payloadKind.case === 'payloadBytes',
    );
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      assert(frame.payloadKind.case === 'payloadBytes');
      expect(Buffer.compare(frame.payloadKind.value, encoded)).toBe(0);
    }
    // Only transport IDs and sequence counters may differ between calls.
    const wire = frames.map(
      (frame) =>
        toBinary(TransportEnvelopeSchema, {
          ...frame,
          id: '',
          streamId: '',
          seq: 0,
          ack: 0,
        }) as Uint8Array,
    );
    expect(Buffer.compare(wire[0], wire[1])).toBe(0);
  });

  test('serde metadata survives reconstructed registrations and legacy getters', async () => {
    const service = ProtoService.define(TestService, {
      echo: withSerde(binary, (bytes) => {
        assert(bytes instanceof Uint8Array);

        return Ok(bytes);
      }),
      countUp: ({ request, resWritable }) => {
        resWritable.write(Ok({ value: request.limit }));
        resWritable.close();
      },
    });
    const reconstructed = new Map(
      [...service.methods].map(
        ([name, registration]) =>
          [
            name,
            new (class {
              get service() {
                return registration.service;
              }

              get method() {
                return registration.method;
              }

              get impl() {
                return registration.impl;
              }

              get input() {
                return registration.input;
              }

              get output() {
                return registration.output;
              }
            })(),
          ] as const,
      ),
    );
    const { client } = start(
      new ProtoService(TestService, undefined, reconstructed),
    );
    await expect(client.echo({ text: 'kept' })).resolves.toEqual(
      Ok(create(EchoResponseSchema, { text: 'kept' })),
    );
    await expect(client.countUp({ limit: 2 }).collect()).resolves.toMatchObject(
      [Ok({ value: 2 })],
    );
  });

  test('custom null inputs and stream directions retain their values', async () => {
    const nullInput: Codec<null> = {
      fromBuffer: () => null,
      toBuffer: () => new Uint8Array(),
    };
    const countInput: Codec<number> = {
      fromBuffer: (bytes) => fromBinary(CountRequestSchema, bytes).limit,
      toBuffer: (limit) =>
        serde.message(CountRequestSchema).toBuffer({ limit }),
    };
    const service = ProtoService.define(TestService, {
      echo: withSerde(
        { input: nullInput, output: serde.message(EchoResponseSchema) },
        (request) => {
          expect(request).toBeNull();

          return Ok({ text: 'null accepted' });
        },
      ),
      countUp: withSerde(
        { input: countInput, output: countOutput },
        ({ request, resWritable }) => {
          resWritable.write(Ok({ value: request }));
          resWritable.close();
        },
      ),
      sum: withSerde(
        { input: serde.binary, output: serde.binary },
        async ({ reqReadable }) => {
          const values = await reqReadable.collect();
          assert(values[0]?.ok);

          return Ok(values[0].payload);
        },
      ),
      chat: withSerde(binary, async ({ reqReadable, resWritable }) => {
        for await (const value of reqReadable) {
          if (value.ok) resWritable.write(Ok(value.payload));
          else {
            resWritable.close(
              Err(
                value.payload.code === 'READABLE_BROKEN'
                  ? {
                      code: RiverErrorCode.UNAVAILABLE,
                      message: value.payload.message,
                    }
                  : value.payload,
              ),
            );

            return;
          }
        }
        resWritable.close();
      }),
    });
    const { client } = start(service);
    await expect(client.echo({})).resolves.toMatchObject(
      Ok({ text: 'null accepted' }),
    );
    await expect(client.countUp({ limit: 7 }).collect()).resolves.toMatchObject(
      [Ok({ value: 7 })],
    );
    const sum = client.sum();
    sum.reqWritable.write({ value: 4 });
    await expect(sum.finalize()).resolves.toMatchObject(Ok({ total: 4 }));
    const chat = client.chat();
    chat.reqWritable.write({ text: 'stream' });
    chat.reqWritable.close();
    await expect(chat.resReadable.collect()).resolves.toMatchObject([
      Ok({ text: 'stream' }),
    ]);
  });

  test.each(['echo', 'countUp'] as const)(
    'typed errors bypass the %s output serde',
    async (method) => {
      const error = {
        code: RiverErrorCode.PERMISSION_DENIED,
        message: 'denied',
        metadata: { reason: 'owner' },
        details: [
          { typeName: 'test.Detail', value: Uint8Array.of(0, 255, 128) },
        ],
      };
      const encode = vi.fn((bytes: Uint8Array) => serde.binary.toBuffer(bytes));
      const output = { ...serde.binary, toBuffer: encode };
      const service = ProtoService.define(TestService, {
        echo: withSerde({ input: serde.binary, output }, () => Err(error)),
        countUp: withSerde({ input: serde.binary, output }, ({ resWritable }) =>
          resWritable.close(Err(error)),
        ),
      });
      const { client } = start(service);
      const result =
        method === 'echo'
          ? await client.echo({})
          : (await client.countUp({}).collect())[0];
      assert(!result.ok && 'details' in result.payload);
      expect(result.payload).toMatchObject({
        code: error.code,
        message: error.message,
        metadata: error.metadata,
      });
      expect(Array.from(result.payload.details?.[0].value ?? [])).toEqual([
        0, 255, 128,
      ]);
      expect(encode).not.toHaveBeenCalled();
    },
  );

  test('a decoder failure rejects the request without calling the handler', async () => {
    const handler = vi.fn(() => Ok(new Uint8Array()));
    const input: Codec<Uint8Array> = {
      ...serde.binary,
      fromBuffer() {
        throw new Error('invalid input');
      },
    };
    const { client, server } = start(
      ProtoService.define(TestService, {
        echo: withSerde({ input, output: serde.binary }, handler),
      }),
    );
    await expect(client.echo({})).resolves.toMatchObject({
      ok: false,
      payload: { code: 'INVALID_REQUEST' },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(server.streams.size).toBe(0);
  });

  test('a non-byte encoder result cannot escape into the envelope', async () => {
    const output: Codec<string> = {
      fromBuffer: () => '',
      // @ts-expect-error Encoder results must be Uint8Array.
      toBuffer: () => ({}),
    };
    const { client } = start(
      ProtoService.define(TestService, {
        echo: withSerde({ input: serde.binary, output }, () => Ok('value')),
      }),
    );
    await expect(client.echo({})).resolves.toMatchObject({
      ok: false,
      payload: { code: UNCAUGHT_ERROR_CODE },
    });
  });

  test.each(['throw', 'cancel'] as const)(
    'server streams clean up after %s',
    async (mode) => {
      const cleaned = vi.fn();
      let signal: AbortSignal | undefined;
      const service = ProtoService.define(TestService, {
        countUp: withSerde(binary, ({ ctx, resWritable }) => {
          signal = ctx.signal;
          ctx.deferCleanup(cleaned);
          resWritable.write(Ok(countOutput.toBuffer({ value: 1 })));
          if (mode === 'throw') throw new Error('handler failed');
        }),
      });
      const { client, server } = start(service);
      const controller = new AbortController();
      const iterator = client
        .countUp({}, { signal: controller.signal })
        [Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        value: Ok({ value: 1 }),
      });
      if (mode === 'cancel') controller.abort();
      await expect(iterator.next()).resolves.toMatchObject({
        value: {
          ok: false,
          payload: {
            code: mode === 'throw' ? UNCAUGHT_ERROR_CODE : CANCEL_CODE,
          },
        },
      });
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      await waitFor(() => expect(server.streams.size).toBe(0));
      expect(signal?.aborted).toBe(true);
      expect(cleaned).toHaveBeenCalledOnce();
      if (mode === 'throw') {
        const failure = sent.find(
          (frame) =>
            frame.payloadKind.case === 'payloadMsgpack' &&
            isSerializedClientErrorResult(decode(frame.payloadKind.value)),
        );
        assert(failure);
        expect(
          sent
            .filter((frame) => frame.streamId === failure.streamId)
            .map((frame) => frame.controlFlags),
        ).toEqual([0, 0, ControlFlags.StreamClosedBit]);
      }
    },
  );
});
