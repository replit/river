import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
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
  type AnyProtoService,
  type Middleware,
  type MiddlewareParam,
  type ServiceImpl,
  type ServiceImplWithRawHandlers,
} from '../protobuf';
import * as messages from '../protobuf/shared';
import { getClientSendFn } from '../testUtil';
import type { MainDefinedProtoService } from '../testUtil/fixtures/protobufMainShape';
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
  CountResponseSchema,
  EchoRequestSchema,
  EchoResponseSchema,
  TestService,
} from '../testUtil/fixtures/protobuf';
import {
  type TestSetupHelpers,
  transports,
} from '../testUtil/fixtures/transports';
import {
  ControlFlags,
  type OpaqueTransportMessage,
} from '../transport/message';

const ProtoService = createProtoService();
const THREE_BYTE_LENGTH_PREFIX_PAYLOAD_SIZE = 145 * 1024;

test('typed-only define calls retain the inferred main service shape', () => {
  const stateless = ProtoService.define(TestService, {
    echo: (request) => Ok({ text: request.text }),
  });
  expectTypeOf(stateless).toEqualTypeOf<
    MainDefinedProtoService<typeof TestService, object, object>
  >();
  const Factory = createProtoService<{ prefix: string }, { userId: string }>();
  const stateful = Factory.define(
    TestService,
    {
      initializeState: () => ({ calls: 0 }),
    },
    {
      echo: (request, ctx) => {
        ctx.state.calls++;

        return Ok({ text: ctx.prefix + request.text + ctx.metadata.userId });
      },
    },
  );
  expectTypeOf(stateful).toEqualTypeOf<
    MainDefinedProtoService<
      typeof TestService,
      { prefix: string },
      { calls: number }
    >
  >();
  expectTypeOf<
    Parameters<typeof Factory.define<typeof TestService, { calls: number }>>[2]
  >().toEqualTypeOf<
    ServiceImpl<
      typeof TestService,
      { prefix: string },
      { calls: number },
      { userId: string }
    >
  >();
  const rawStateful = Factory.define(
    TestService,
    {
      initializeState: () => ({ calls: 0 }),
    },
    {
      echo: {
        raw: (request, ctx) => {
          expectTypeOf(request).toEqualTypeOf<Uint8Array>();
          expectTypeOf(ctx.state.calls).toEqualTypeOf<number>();
          expectTypeOf(ctx.prefix).toEqualTypeOf<string>();
          expectTypeOf(ctx.metadata.userId).toEqualTypeOf<string>();

          return Ok(request);
        },
      },
    },
  );
  expectTypeOf(rawStateful).toEqualTypeOf<typeof stateful>();
  const scaffold = Factory.scaffold(TestService, {
    initializeState: () => ({ calls: 0 }),
  });
  const handlers = scaffold.procedures({
    echo: (request) => Ok({ text: request.text }),
  });
  expectTypeOf(handlers).toEqualTypeOf<
    ServiceImpl<
      typeof TestService,
      { prefix: string },
      { calls: number },
      { userId: string }
    >
  >();
  expectTypeOf(scaffold.finalize(handlers)).toEqualTypeOf<typeof stateful>();
});

test('typed scaffold helpers do not accept raw-handler entries', () => {
  const raw = () => Ok(new Uint8Array());
  const scaffold = ProtoService.scaffold(TestService, {
    initializeState: () => ({}),
  });
  const checkTypes = () => {
    // @ts-expect-error The existing procedures API accepts typed functions only.
    scaffold.procedures({ echo: { raw } });
    // @ts-expect-error The existing finalize API accepts typed functions only.
    scaffold.finalize({ echo: { raw } });
  };
  expectTypeOf(checkTypes).toBeFunction();
});

function countResponseBytes(value: number): Uint8Array {
  return toBinary(
    CountResponseSchema,
    create(CountResponseSchema, { value }),
  ) as Uint8Array;
}

test('raw handlers must be functions at definition time', () => {
  expect(() =>
    ProtoService.define(TestService, {
      echo: {
        // @ts-expect-error Raw handlers must be callable.
        raw: 42,
      },
    }),
  ).toThrow('raw handler must be a function');
});

test('raw handlers cannot implement client-streaming or bidi methods', () => {
  const raw = () => Ok(new Uint8Array());
  expect(() =>
    ProtoService.define(TestService, {
      // @ts-expect-error Raw handlers cannot implement client-streaming methods.
      sum: { raw },
    }),
  ).toThrow('raw handlers require a unary or server-streaming method');
  expect(() =>
    ProtoService.define(TestService, {
      // @ts-expect-error Raw handlers cannot implement bidi methods.
      chat: { raw },
    }),
  ).toThrow('raw handlers require a unary or server-streaming method');
});

describe.each(transports)(
  'raw protobuf handlers ($name transport)',
  (transport) => {
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
          vi.restoreAllMocks();
        }
      };
    });

    function start(
      handlers:
        | ServiceImplWithRawHandlers<typeof TestService>
        | AnyProtoService,
      middlewares: Array<Middleware> = [],
    ) {
      const clientTransport = setup.getClientTransport('client');
      const serverTransport = setup.getServerTransport();
      const server = createServer(
        serverTransport,
        [
          'instantiate' in handlers
            ? handlers
            : ProtoService.define(TestService, handlers),
        ],
        { middlewares },
      );
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

      return { client, clientTransport, serverTransport, server };
    }

    test('legacy getter-backed registrations dispatch through the typed codec', async () => {
      const service = ProtoService.define(TestService, {
        echo: (request, ctx) => {
          expect(ctx.service).toBe(TestService);
          expect(ctx.method).toBe(TestService.method.echo);

          return Ok({ text: request.text.toUpperCase() });
        },
      });
      const registrations = new Map(
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
              })(),
            ] as const,
        ),
      );
      const legacyService = new ProtoService(
        TestService,
        undefined,
        registrations,
      );
      const { client, server } = start(legacyService);

      await expect(client.echo({ text: 'getter' })).resolves.toEqual(
        Ok(create(EchoResponseSchema, { text: 'GETTER' })),
      );
      await waitFor(() => expect(server.streams.size).toBe(0));
    });

    test.each([0, 2])(
      'raw requests retain their bytes with %i middleware functions',
      async (middlewareCount) => {
        const decoded = vi.spyOn(messages, 'decodeMessageBytes');
        const encoded = vi.spyOn(messages, 'encodeMessageBytes');
        const requests: Array<MiddlewareParam['reqInit']> = [];
        let received: Uint8Array | undefined;
        const { client } = start(
          {
            echo: {
              raw: (request, ctx) => {
                received = request;
                expect(ctx.service).toBe(TestService);
                expect(ctx.method).toBe(TestService.method.echo);

                return Ok(request);
              },
            },
          },
          Array.from({ length: middlewareCount }, () => ({ reqInit, next }) => {
            requests.push(reqInit);
            next();
          }),
        );

        await expect(client.echo({ text: 'hello' })).resolves.toEqual(
          Ok(create(EchoResponseSchema, { text: 'hello' })),
        );
        assert(received);
        expect(
          Buffer.compare(
            received,
            toBinary(
              EchoRequestSchema,
              create(EchoRequestSchema, { text: 'hello' }),
            ) as Uint8Array,
          ),
        ).toBe(0);
        expect(received.byteOffset).toBeGreaterThan(0);
        expect(
          decoded.mock.calls.filter(([schema]) => schema === EchoRequestSchema),
        ).toHaveLength(middlewareCount === 0 ? 0 : 1);
        expect(
          encoded.mock.calls.filter(
            ([schema]) => schema === EchoResponseSchema,
          ),
        ).toHaveLength(0);
        expect(requests).toHaveLength(middlewareCount);
        if (middlewareCount > 0) {
          expect(requests[0]).toEqual(
            create(EchoRequestSchema, { text: 'hello' }),
          );
          expect(requests[1]).toBe(requests[0]);
        }
      },
    );

    test('middleware rejects malformed raw requests before invoking the handler', async () => {
      const handler = vi.fn(() => Ok(new Uint8Array()));
      const middleware = vi.fn<Middleware>(({ next }) => next());
      const { clientTransport, serverTransport, server } = start(
        { echo: { raw: handler } },
        [middleware],
      );
      const received: Array<OpaqueTransportMessage> = [];
      clientTransport.addEventListener('message', (message) =>
        received.push(message),
      );
      getClientSendFn(
        clientTransport,
        serverTransport,
      )({
        streamId: 'malformed',
        serviceName: TestService.typeName,
        procedureName: TestService.method.echo.name,
        payload: Uint8Array.of(255),
        controlFlags: ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
      });

      await waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toMatchObject({
        payload: { ok: false, payload: { code: 'INVALID_REQUEST' } },
      });
      expect(handler).not.toHaveBeenCalled();
      expect(middleware).not.toHaveBeenCalled();
      expect(server.streams.size).toBe(0);
    });

    test.each([
      { name: 'empty', text: '' },
      { name: 'small', text: 'hello' },
      {
        name: 'three-byte length prefix',
        text: 'x'.repeat(THREE_BYTE_LENGTH_PREFIX_PAYLOAD_SIZE),
      },
    ])(
      'typed and raw responses have identical wire bytes ($name)',
      async ({ text }) => {
        const response = create(EchoResponseSchema, { text });
        const bytes = toBinary(EchoResponseSchema, response) as Uint8Array;
        const backing = new Uint8Array(bytes.length + 2).fill(255);
        backing.set(bytes, 1);
        const { client, server, serverTransport } = start({
          echo: () => Ok(response),
        });
        await expect(client.echo({})).resolves.toEqual(Ok(response));
        await server.close();
        const rawServer = createServer(serverTransport, [
          ProtoService.define(TestService, {
            echo: { raw: () => Ok(backing.subarray(1, backing.length - 1)) },
          }),
        ]);
        addPostTestCleanup(async () => {
          try {
            await waitFor(() => expect(rawServer.streams.size).toBe(0));
          } finally {
            serverTransport.close();
            await rawServer.close();
          }
        });
        await expect(client.echo({})).resolves.toEqual(Ok(response));

        const responses = sent.filter(
          (envelope) => envelope.payloadKind.case === 'payloadBytes',
        );
        expect(responses).toHaveLength(2);
        for (const envelope of responses) {
          assert(envelope.payloadKind.case === 'payloadBytes');
          expect(Buffer.compare(envelope.payloadKind.value, bytes)).toBe(0);
        }
        // Envelope IDs and sequence counters are the only permitted differences.
        const normalized = responses.map(
          (envelope) =>
            toBinary(TransportEnvelopeSchema, {
              ...envelope,
              id: '',
              streamId: '',
              seq: 0,
              ack: 0,
            }) as Uint8Array,
        );
        expect(Buffer.compare(normalized[1], normalized[0])).toBe(0);
      },
    );

    test.each(['echo', 'countUp'] as const)(
      'raw %s preserves typed error metadata and details',
      async (method) => {
        const error = {
          code: RiverErrorCode.PERMISSION_DENIED,
          message: 'not yours',
          metadata: { reason: 'owner', 'service-terminal': 'false' },
          details: [
            {
              typeName: 'example.OpaqueDetail',
              value: Uint8Array.of(0, 255, 128),
            },
          ],
        };
        const { client } = start({
          echo: { raw: () => Err(error) },
          countUp: {
            raw: ({ resWritable }) => {
              resWritable.write(Ok(countResponseBytes(1)));
              resWritable.close(Err(error));
            },
          },
        });
        const results =
          method === 'echo'
            ? [await client.echo({})]
            : await client.countUp({ limit: 1 }).collect();
        const result = results.at(-1);
        assert(result && !result.ok && 'details' in result.payload);
        expect(result.payload).toMatchObject({
          code: error.code,
          message: error.message,
          metadata: error.metadata,
        });
        expect(
          result.payload.details?.map((detail) => ({
            typeName: detail.typeName,
            value: Array.from(detail.value),
          })),
        ).toEqual([{ typeName: 'example.OpaqueDetail', value: [0, 255, 128] }]);
        if (method === 'countUp')
          expect(results[0]).toMatchObject(Ok({ value: 1 }));
      },
    );

    test('an exception after a raw frame sends an error and closes the stream', async () => {
      const { client, server } = start({
        countUp: {
          raw: ({ resWritable }) => {
            resWritable.write(Ok(countResponseBytes(1)));
            throw new Error('handler failed');
          },
        },
      });
      const results = await client.countUp({ limit: 1 }).collect();
      expect(results).toMatchObject([
        Ok({ value: 1 }),
        Err({ code: UNCAUGHT_ERROR_CODE, message: 'handler failed' }),
      ]);
      const errorFrame = sent.find(
        (envelope) =>
          envelope.payloadKind.case === 'payloadMsgpack' &&
          isSerializedClientErrorResult(decode(envelope.payloadKind.value)),
      );
      assert(errorFrame);
      expect(
        sent
          .filter((envelope) => envelope.streamId === errorFrame.streamId)
          .map((envelope) => envelope.controlFlags),
      ).toEqual([0, 0, ControlFlags.StreamClosedBit]);
      await waitFor(() => expect(server.streams.size).toBe(0));
    });

    test('canceling a raw stream aborts its producer and runs cleanup', async () => {
      let signal: AbortSignal | undefined;
      const cleaned = vi.fn();
      const { client, server } = start({
        countUp: {
          raw: ({ ctx, resWritable }) => {
            signal = ctx.signal;
            ctx.deferCleanup(cleaned);
            resWritable.write(Ok(countResponseBytes(1)));
          },
        },
      });
      const controller = new AbortController();
      const iterator = client
        .countUp({ limit: 1 }, { signal: controller.signal })
        [Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({
        value: Ok({ value: 1 }),
      });
      controller.abort();
      await expect(iterator.next()).resolves.toMatchObject({
        value: { ok: false, payload: { code: CANCEL_CODE } },
      });
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      await waitFor(() => expect(server.streams.size).toBe(0));
      expect(signal?.aborted).toBe(true);
      expect(cleaned).toHaveBeenCalledOnce();
    });

    test('typed and raw methods coexist with callable scaffold results', async () => {
      const initializeState = () => ({});
      const scaffold = ProtoService.scaffold(TestService, {
        initializeState,
      });
      const typed = scaffold.procedures({
        echo: (request) => Ok({ text: request.text.toUpperCase() }),
      });
      const raw = {
        countUp: {
          raw: ({ ctx, resWritable }) => {
            expect(ctx.method).toBe(TestService.method.countUp);
            resWritable.write(Ok(countResponseBytes(1)));
            resWritable.write(Ok(countResponseBytes(2)));
            resWritable.close();
          },
        },
      } satisfies ServiceImplWithRawHandlers<typeof TestService>;
      expectTypeOf(typed).toEqualTypeOf<
        ServiceImpl<
          typeof TestService,
          object,
          ReturnType<typeof initializeState>
        >
      >();
      expectTypeOf(raw.countUp.raw).toBeFunction();
      const { client } = start({ ...typed, ...raw });

      await expect(client.echo({ text: 'typed' })).resolves.toEqual(
        Ok(create(EchoResponseSchema, { text: 'TYPED' })),
      );
      await expect(
        client.countUp({ limit: 2 }).collect(),
      ).resolves.toMatchObject([Ok({ value: 1 }), Ok({ value: 2 })]);
    });

    test('non-byte raw responses fail before serialization', async () => {
      const { client } = start({
        echo: {
          // @ts-expect-error Raw success payloads must be Uint8Array.
          raw: () => Ok({}),
        },
      });
      await expect(client.echo({})).resolves.toMatchObject(
        Err({
          code: UNCAUGHT_ERROR_CODE,
          message: 'raw protobuf handlers must return Uint8Array payloads',
        }),
      );
    });
  },
);
