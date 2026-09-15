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
  Err,
  Ok,
  ProtoCodec,
  RiverErrorCode,
  INVALID_REQUEST_CODE,
  UNCAUGHT_ERROR_CODE,
  createClient,
  createProtoService,
  createClientHandshakeOptions,
  createServerHandshakeOptions,
  createServer,
  isSerializedClientErrorResult,
  type RawMethodImpl,
  type ServiceImpl,
} from '../protobuf';
import {
  TransportEnvelopeSchema,
  type TransportEnvelope,
} from '../protobuf/gen/transport_pb';
import { getClientSendFn } from '../testUtil';
import {
  cleanupTransports,
  createPostTestCleanups,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import {
  AuthHandshakeSchema,
  EchoRequestSchema,
  EchoResponseSchema,
  CountResponseSchema,
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
const methods = ['echo', 'countUp'] as const;

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

describe.each(transports)(
  'raw protobuf wire ($name transport)',
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
      const clientTransport = setup.getClientTransport('client');
      const serverTransport = setup.getServerTransport();
      const server = createServer(serverTransport, [
        ProtoService.define(TestService, handlers),
      ]);
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

    test.each([
      { name: 'empty', text: '' },
      { name: 'small', text: 'hello' },
      { name: '145 KiB', text: 'x'.repeat(145 * 1024) },
    ])(
      'typed and raw responses have identical field-11 bytes ($name)',
      async ({ text }) => {
        const response = create(EchoResponseSchema, { text });
        const bytes = toBinary(EchoResponseSchema, response) as Uint8Array;
        const backing = new Uint8Array(bytes.length + 2).fill(255);
        backing.set(bytes, 1);
        const { client, server, serverTransport } = start({
          echo: () => Ok(response),
        });
        await expect(client.echo({ text })).resolves.toEqual(Ok(response));
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
        await expect(client.echo({ text })).resolves.toEqual(Ok(response));

        const responses = sent.filter(
          (envelope) => envelope.payloadKind.case === 'payloadBytes',
        );
        expect(responses).toHaveLength(2);
        for (const envelope of responses) {
          assert(envelope.payloadKind.case === 'payloadBytes');
          expect(Buffer.compare(envelope.payloadKind.value, bytes)).toBe(0);
        }
        // IDs and sequence counters differ between calls; all other envelope bytes must match.
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

    test.each(methods)(
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
              resWritable.write(
                Ok(
                  toBinary(
                    CountResponseSchema,
                    create(CountResponseSchema, { value: 1 }),
                  ),
                ),
              );
              resWritable.close(Err(error));
            },
          },
        });
        const results =
          method === 'echo'
            ? [await client.echo({})]
            : await client.countUp({ limit: 1 }).collect();
        const result = results.at(-1);
        assert(result && !result.ok);
        expect(result.payload).toMatchObject({
          code: error.code,
          message: error.message,
          metadata: error.metadata,
        });
        assert('details' in result.payload);
        expect(
          result.payload.details?.map((detail) => ({
            typeName: detail.typeName,
            value: Array.from(detail.value),
          })),
        ).toEqual([{ typeName: 'example.OpaqueDetail', value: [0, 255, 128] }]);
        if (method === 'countUp')
          expect(results[0]).toEqual(
            Ok(create(CountResponseSchema, { value: 1 })),
          );
        const errorFrame = sent.find(
          (envelope) =>
            envelope.payloadKind.case === 'payloadMsgpack' &&
            isSerializedClientErrorResult(decode(envelope.payloadKind.value)),
        );
        expect(errorFrame?.controlFlags).toBe(
          method === 'echo' ? ControlFlags.StreamClosedBit : 0,
        );
      },
    );

    describe.each(methods)('opening a raw %s method', (method) => {
      test.each([
        {
          name: 'missing open bit',
          flags: ControlFlags.StreamClosedBit,
          payload: new Uint8Array(),
          serviceName: TestService.typeName,
          procedureName: TestService.method[method].name,
          code: INVALID_REQUEST_CODE,
        },
        {
          name: 'missing close bit',
          flags: ControlFlags.StreamOpenBit,
          payload: new Uint8Array(),
          serviceName: TestService.typeName,
          procedureName: TestService.method[method].name,
          code: INVALID_REQUEST_CODE,
        },
        {
          name: 'non-byte payload',
          flags: ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
          payload: {},
          serviceName: TestService.typeName,
          procedureName: TestService.method[method].name,
          code: INVALID_REQUEST_CODE,
        },
        {
          name: 'unknown service',
          flags: ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
          payload: new Uint8Array(),
          serviceName: 'missing.Service',
          procedureName: TestService.method[method].name,
          code: RiverErrorCode.UNIMPLEMENTED,
        },
        {
          name: 'unknown method',
          flags: ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
          payload: new Uint8Array(),
          serviceName: TestService.typeName,
          procedureName: 'Missing',
          code: RiverErrorCode.UNIMPLEMENTED,
        },
      ])(
        'rejects $name before calling the handler',
        async ({ flags, payload, serviceName, procedureName, code }) => {
          const called = vi.fn();
          const { clientTransport, serverTransport } = start({
            echo: {
              raw: () => {
                called();

                return Ok(new Uint8Array());
              },
            },
            countUp: {
              raw: ({ resWritable }) => {
                called();
                resWritable.close();
              },
            },
          });
          const received: Array<OpaqueTransportMessage> = [];
          clientTransport.addEventListener('message', (message) => {
            if (message.streamId === 'invalid') received.push(message);
          });
          getClientSendFn(
            clientTransport,
            serverTransport,
          )({
            streamId: 'invalid',
            serviceName,
            procedureName,
            payload,
            controlFlags: flags,
          });

          await waitFor(() => expect(received).toHaveLength(1));
          expect(received[0]).toMatchObject({
            controlFlags: ControlFlags.StreamCancelBit,
            payload: { ok: false, payload: { code } },
          });
          expect(called).not.toHaveBeenCalled();
        },
      );
    });

    test.each(methods)(
      'uncaught raw %s exceptions keep native error-plus-close',
      async (method) => {
        const fail = () => {
          throw new Error('handler failed');
        };
        const { client } = start({
          echo: { raw: fail },
          countUp: {
            raw: ({ resWritable }) => {
              resWritable.write(
                Ok(
                  toBinary(
                    CountResponseSchema,
                    create(CountResponseSchema, { value: 1 }),
                  ),
                ),
              );
              fail();
            },
          },
        });
        const results =
          method === 'echo'
            ? [await client.echo({})]
            : await client.countUp({ limit: 1 }).collect();
        expect(results.at(-1)).toMatchObject(
          Err({ code: UNCAUGHT_ERROR_CODE, message: 'handler failed' }),
        );
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
        ).toEqual(
          method === 'echo'
            ? [ControlFlags.StreamClosedBit]
            : [0, 0, ControlFlags.StreamClosedBit],
        );
      },
    );

    test('a non-byte raw success becomes an uncaught error, not a msgpack success', async () => {
      const invalid = (): ReturnType<
        RawMethodImpl<typeof TestService.method.echo>
      > => {
        // @ts-expect-error Exercise JavaScript callers that violate the raw output contract.
        return Ok({ text: 'not bytes' });
      };
      const { client } = start({ echo: { raw: invalid } });

      await expect(client.echo({})).resolves.toMatchObject(
        Err({
          code: UNCAUGHT_ERROR_CODE,
          message: 'raw protobuf handlers must return Uint8Array payloads',
        }),
      );
    });

    test('raw bodies remain opaque while typed methods still reject invalid protobuf', async () => {
      const invalid = Uint8Array.of(255);
      let received: Uint8Array | undefined;
      const { clientTransport, serverTransport } = start({
        echo: {
          raw: (bytes) => {
            received = new Uint8Array(bytes);

            return Ok(new Uint8Array());
          },
        },
        countUp: ({ resWritable }) => resWritable.close(),
      });
      const messages: Array<OpaqueTransportMessage> = [];
      clientTransport.addEventListener('message', (message) =>
        messages.push(message),
      );
      const send = getClientSendFn(clientTransport, serverTransport);
      for (const method of methods)
        send({
          streamId: method,
          serviceName: TestService.typeName,
          procedureName: TestService.method[method].name,
          payload: invalid,
          controlFlags:
            ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
        });

      await waitFor(() => expect(messages).toHaveLength(2));
      expect(received).toEqual(invalid);
      expect(
        messages.find((message) => message.streamId === 'countUp'),
      ).toMatchObject({
        payload: { ok: false, payload: { code: INVALID_REQUEST_CODE } },
      });
    });

    test('raw handlers keep the typed protobuf handshake and middleware context', async () => {
      const handshake = createServerHandshakeOptions(
        AuthHandshakeSchema,
        (request) => ({ token: request.token }),
      );
      const service = createProtoService<object, { token: string }>().define(
        TestService,
        {
          echo: {
            raw: (request, ctx) => {
              expectTypeOf(request).toEqualTypeOf<Uint8Array>();
              expect(ctx.metadata.token).toBe('verified');

              return Ok(request);
            },
          },
        },
      );
      const clientTransport = setup.getClientTransport('client');
      const serverTransport = setup.getServerTransport<
        typeof handshake.schema,
        { token: string }
      >();
      let observed: Uint8Array | undefined;
      const server = createServer(serverTransport, [service], {
        handshakeOptions: handshake,
        middlewares: [
          ({ reqInit, ctx, next }) => {
            assert(reqInit?.kind === 'raw');
            observed = new Uint8Array(reqInit.bytes);
            expect(ctx.service).toBe(TestService);
            expect(ctx.method).toBe(TestService.method.echo);
            next();
          },
        ],
      });
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
        await server.close();
      });
      const client = createClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
        {
          handshakeOptions: createClientHandshakeOptions(
            AuthHandshakeSchema,
            () => ({ token: 'verified' }),
          ),
        },
      );

      await expect(client.echo({ text: 'hello' })).resolves.toEqual(
        Ok(create(EchoResponseSchema, { text: 'hello' })),
      );
      expect(observed).toEqual(
        toBinary(
          EchoRequestSchema,
          create(EchoRequestSchema, { text: 'hello' }),
        ),
      );
      expectTypeOf<
        RawMethodImpl<typeof TestService.method.sum>
      >().toEqualTypeOf<never>();
      expectTypeOf<
        RawMethodImpl<typeof TestService.method.chat>
      >().toEqualTypeOf<never>();
    });
  },
);
