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
  type MiddlewareParam,
  type ServiceImpl,
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
  CountResponseSchema,
  EchoRequestSchema,
  EchoResponseSchema,
  TestService,
} from '../testUtil/fixtures/protobuf';
import {
  type TestSetupHelpers,
  transports,
} from '../testUtil/fixtures/transports';
import { ControlFlags } from '../transport/message';

const ProtoService = createProtoService();
const THREE_BYTE_LENGTH_PREFIX_PAYLOAD_SIZE = 145 * 1024;

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
        }
      };
    });

    function start(handlers: ServiceImpl<typeof TestService>) {
      const requests: Array<MiddlewareParam['reqInit']> = [];
      const clientTransport = setup.getClientTransport('client');
      const serverTransport = setup.getServerTransport();
      const server = createServer(
        serverTransport,
        [ProtoService.define(TestService, handlers)],
        {
          middlewares: [
            ({ reqInit, next }) => {
              requests.push(reqInit);
              next();
            },
          ],
        },
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

      return { client, serverTransport, server, requests };
    }

    test('raw requests retain the exact client bytes and reach middleware as a view', async () => {
      let received: Uint8Array | undefined;
      const { client, requests } = start({
        echo: {
          raw: (request, ctx) => {
            received = request;
            expect(ctx.service).toBe(TestService);
            expect(ctx.method).toBe(TestService.method.echo);

            return Ok(request);
          },
        },
      });

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
      const request = requests[0];
      assert(request?.kind === 'raw');
      expect(request.bytes).toBe(received);
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
      const scaffold = ProtoService.scaffold(TestService, {
        initializeState: () => ({}),
      });
      const typed = scaffold.procedures({
        echo: (request) => Ok({ text: request.text.toUpperCase() }),
      });
      const raw = scaffold.procedures({
        countUp: {
          raw: ({ ctx, resWritable }) => {
            expect(ctx.method).toBe(TestService.method.countUp);
            resWritable.write(Ok(countResponseBytes(1)));
            resWritable.write(Ok(countResponseBytes(2)));
            resWritable.close();
          },
        },
      });
      expectTypeOf(typed.echo).toBeFunction();
      expectTypeOf(raw.countUp.raw).toBeFunction();
      const { client, requests } = start({ ...typed, ...raw });

      await expect(client.echo({ text: 'typed' })).resolves.toEqual(
        Ok(create(EchoResponseSchema, { text: 'TYPED' })),
      );
      await expect(
        client.countUp({ limit: 2 }).collect(),
      ).resolves.toMatchObject([Ok({ value: 1 }), Ok({ value: 2 })]);
      expect(requests).toMatchObject([
        { kind: 'message', message: { text: 'typed' } },
        { kind: 'raw' },
      ]);
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
