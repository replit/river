import { create, toBinary } from '@bufbuild/protobuf';
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
  type AnyProtoService,
  type Middleware,
  type RawHandler,
  type ServiceImplWithRawHandlers,
} from '../protobuf';
import {
  cleanupTransports,
  createPostTestCleanups,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import {
  CountResponseSchema,
  EchoRequestSchema,
  EchoResponseSchema,
  TestService,
  type CountRequest,
} from '../testUtil/fixtures/protobuf';
import {
  type TestSetupHelpers,
  transports,
} from '../testUtil/fixtures/transports';
import {
  ControlFlags,
  type OpaqueTransportMessage,
} from '../transport/message';

const ProtoService = createProtoService<
  { prefix: string },
  { userId: string }
>();

test('raw handlers require byte responses', () => {
  const echo: RawHandler<typeof TestService.method.echo> = {
    raw: 'both',
    // @ts-expect-error Raw successes must be bytes, not protobuf messages.
    handler: () => Ok({ text: 'not bytes' }),
  };
  ProtoService.define(TestService, { echo });
});

describe.each(transports)(
  'protobuf raw handlers ($name transport)',
  (transport) => {
    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let setup: TestSetupHelpers;
    let inbound: Array<Uint8Array>;
    let replies: Array<OpaqueTransportMessage>;
    beforeEach(async () => {
      inbound = [];
      replies = [];
      setup = await transport.setup({
        client: { codec: ProtoCodec },
        server: { codec: ProtoCodec },
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
      serverTransport.addEventListener('message', ({ payload }) => {
        if (payload instanceof Uint8Array) inbound.push(payload);
      });
      clientTransport.addEventListener('message', (message) =>
        replies.push(message),
      );
      const server = createServer(serverTransport, [service], {
        extendedContext: { prefix: 'raw' },
        middlewares,
      });
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

      return { client, server };
    }

    test('binary input is owned and late middleware shares the original protobuf request', async () => {
      const request = create(EchoRequestSchema, { text: 'owned' });
      const bytes = toBinary(EchoRequestSchema, request) as Uint8Array;
      const service = ProtoService.define(
        TestService,
        { initializeState: (ctx) => ({ calls: ctx.prefix.length }) },
        {
          echo: {
            raw: 'both',
            handler: (input, ctx) => {
              expectTypeOf(input).toEqualTypeOf<Uint8Array>();
              expectTypeOf(ctx.prefix).toEqualTypeOf<string>();
              expectTypeOf(ctx.state.calls).toEqualTypeOf<number>();
              expectTypeOf(ctx.metadata).toEqualTypeOf<{ userId: string }>();
              expect(ctx.state.calls).toBe(3);
              expect(input.byteOffset).toBe(0);
              expect(input.buffer.byteLength).toBe(input.byteLength);
              expect(input.buffer).not.toBe(inbound[0]?.buffer);
              expect(input).toEqual(bytes);
              const response = input.slice();
              input.fill(255);

              return Ok(response);
            },
          },
        },
      );
      const middlewares: Array<Middleware> = [];
      const methods = new Map(
        [...service.methods].map(([name, method]) => [name, { ...method }]),
      );
      const { client } = start(
        new ProtoService(TestService, service.initializeStateFn, methods),
        middlewares,
      );
      const seen: Array<unknown> = [];
      const observer: Middleware = ({ reqInit, next }) => {
        seen.push(reqInit);
        next();
      };
      middlewares.push(observer, observer);

      await expect(client.echo(request)).resolves.toEqual(
        Ok(create(EchoResponseSchema, { text: 'owned' })),
      );
      expect(Buffer.compare(inbound[0], bytes)).toBe(0);
      expect(seen).toEqual([request, request]);
      expect(seen[0]).toBe(seen[1]);
    });

    test('raw streams preserve output subviews, typed errors, and typed clients', async () => {
      const response = create(CountResponseSchema, { value: 7 });
      // A repeated scalar field disappears if the response is re-encoded.
      const encoded = Uint8Array.of(
        8,
        1,
        ...(toBinary(CountResponseSchema, response) as Uint8Array),
      );
      const backing = new Uint8Array(encoded.length + 2).fill(255);
      backing.set(encoded, 1);
      const error = {
        code: RiverErrorCode.PERMISSION_DENIED,
        message: 'denied',
        metadata: { reason: 'owner' },
      };
      const handlers = {
        echo: (request) => Ok({ text: request.text }),
        countUp: {
          raw: 'output',
          handler: ({ request, resWritable }) => {
            expectTypeOf(request).toEqualTypeOf<CountRequest>();
            expect(request.limit).toBe(7);
            resWritable.write(Ok(backing.subarray(1, -1)));
            resWritable.close(Err(error));
          },
        },
        sum: {
          raw: 'both',
          handler: async ({ reqReadable }) => {
            const values = await reqReadable.collect();
            assert(values[0]?.ok);
            expectTypeOf(values[0].payload).toEqualTypeOf<Uint8Array>();
            expect(values[0].payload.byteOffset).toBe(0);

            return Ok(values[0].payload);
          },
        },
        chat: {
          raw: 'both',
          handler: async ({ reqReadable, resWritable }) => {
            for await (const value of reqReadable) {
              assert(value.ok);
              expectTypeOf(value.payload).toEqualTypeOf<Uint8Array>();
              resWritable.write(Ok(value.payload));
            }
            resWritable.close();
          },
        },
      } satisfies ServiceImplWithRawHandlers<typeof TestService>;
      const { client } = start(ProtoService.define(TestService, handlers));
      const results = await client.countUp({ limit: 7 }).collect();
      expect(results).toEqual([Ok(response), Err(error)]);
      assert(replies[0].payload instanceof Uint8Array);
      expect(Buffer.compare(replies[0].payload, encoded)).toBe(0);
      const sum = client.sum();
      sum.reqWritable.write({ value: 4 });
      await expect(sum.finalize()).resolves.toMatchObject(Ok({ total: 4 }));
      const chat = client.chat();
      chat.reqWritable.write({ text: 'first' });
      chat.reqWritable.write({ text: 'second' });
      chat.reqWritable.close();
      await expect(chat.resReadable.collect()).resolves.toMatchObject([
        Ok({ text: 'first' }),
        Ok({ text: 'second' }),
      ]);
      await expect(client.echo({ text: 'typed' })).resolves.toMatchObject(
        Ok({ text: 'typed' }),
      );
    });

    test.each(['throw', 'cancel'] as const)(
      'raw streams clean up after %s',
      async (mode) => {
        const cleaned = vi.fn();
        let signal: AbortSignal | undefined;
        const { client, server } = start(
          ProtoService.define(TestService, {
            countUp: {
              raw: 'both',
              handler: ({ request, ctx, resWritable }) => {
                expectTypeOf(request).toEqualTypeOf<Uint8Array>();
                signal = ctx.signal;
                ctx.deferCleanup(cleaned);
                resWritable.write(Ok(request));
                if (mode === 'throw') throw new Error('handler failed');
              },
            },
          }),
        );
        const controller = new AbortController();
        const iterator = client
          .countUp({ limit: 1 }, { signal: controller.signal })
          [Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toMatchObject({
          value: Ok({ value: 1 }),
        });
        if (mode === 'cancel') controller.abort();
        const code = mode === 'throw' ? UNCAUGHT_ERROR_CODE : CANCEL_CODE;
        const expectedError = { ok: false, payload: { code } };
        await expect(iterator.next()).resolves.toMatchObject({
          value: expectedError,
        });
        await expect(iterator.next()).resolves.toMatchObject({ done: true });
        await waitFor(() => expect(server.streams.size).toBe(0));
        expect(signal?.aborted).toBe(true);
        expect(cleaned).toHaveBeenCalledOnce();
        if (mode === 'throw') {
          expect(replies.map(({ controlFlags }) => controlFlags)).toEqual([
            0,
            0,
            ControlFlags.StreamClosedBit,
          ]);
          expect(replies[1].payload).toMatchObject(expectedError);
        }
      },
    );
  },
);
