import { create, toBinary } from '@bufbuild/protobuf';
import { beforeEach, describe, expect, expectTypeOf, test } from 'vitest';
import {
  Ok,
  ProtoCodec,
  createClient,
  createProtoService,
  createServer,
  type ServiceImpl,
} from '../protobuf';
import {
  cleanupTransports,
  createPostTestCleanups,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import {
  EchoRequestSchema,
  EchoResponseSchema,
  TestService,
} from '../testUtil/fixtures/protobuf';
import {
  type TestSetupHelpers,
  transports,
} from '../testUtil/fixtures/transports';

const ProtoService = createProtoService();

describe.each(transports)(
  'raw protobuf handlers ($name transport)',
  (transport) => {
    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let setup: TestSetupHelpers;

    beforeEach(async () => {
      setup = await transport.setup({
        client: { codec: ProtoCodec },
        server: { codec: ProtoCodec },
      });

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    test('raw unary preserves request bytes and returns a response to a typed client', async () => {
      const request = create(EchoRequestSchema, { text: 'hello' });
      const response = create(EchoResponseSchema, { text: 'HELLO' });
      let received: Uint8Array | undefined;
      const clientTransport = setup.getClientTransport('client');
      const serverTransport = setup.getServerTransport();
      const service = ProtoService.define(TestService, {
        echo: {
          raw: (bytes, ctx) => {
            received = new Uint8Array(bytes);
            expect(ctx.service).toBe(TestService);
            expect(ctx.method).toBe(TestService.method.echo);

            return Ok(toBinary(EchoResponseSchema, response));
          },
        },
      });
      const server = createServer(serverTransport, [service]);
      addPostTestCleanup(async () => {
        await waitFor(() => expect(server.streams.size).toBe(0));
        await server.close();
        await cleanupTransports([clientTransport, serverTransport]);
      });
      const client = createClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
      );

      await expect(client.echo(request)).resolves.toEqual(Ok(response));
      expect(received).toEqual(toBinary(EchoRequestSchema, request));
    });

    test('typed-only scaffold retains its contract beside a raw method', async () => {
      const scaffold = ProtoService.scaffold(TestService, {
        initializeState: () => ({ calls: 0 }),
      });
      const typed = scaffold.procedures({
        countUp: ({ request, ctx, resWritable }) => {
          ctx.state.calls++;
          resWritable.write(Ok({ value: request.limit + ctx.state.calls }));
          resWritable.close();
        },
      });
      expectTypeOf(typed).toEqualTypeOf<
        ServiceImpl<typeof TestService, object, { calls: number }>
      >();
      const typedOnly: ServiceImpl<
        typeof TestService,
        object,
        { calls: number }
      > = typed;
      const service = scaffold.finalize({
        ...typedOnly,
        echo: { raw: (request) => Ok(request) },
      });
      const clientTransport = setup.getClientTransport('client');
      const serverTransport = setup.getServerTransport();
      const server = createServer(serverTransport, [service]);
      addPostTestCleanup(async () => {
        await waitFor(() => expect(server.streams.size).toBe(0));
        await server.close();
        await cleanupTransports([clientTransport, serverTransport]);
      });
      const client = createClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
      );

      await expect(client.echo({ text: 'raw' })).resolves.toEqual(
        Ok(create(EchoResponseSchema, { text: 'raw' })),
      );
      await expect(
        client.countUp({ limit: 4 }).collect(),
      ).resolves.toMatchObject([Ok({ value: 5 })]);
    });
  },
);
