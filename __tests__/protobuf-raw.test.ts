import { create, toBinary } from '@bufbuild/protobuf';
import { beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest';
import {
  Ok,
  ProtoCodec,
  createClient,
  createProtoService,
  createServer,
  type ServiceImpl,
  CANCEL_CODE,
} from '../protobuf';
import {
  cleanupTransports,
  createPostTestCleanups,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import {
  EchoRequestSchema,
  EchoResponseSchema,
  CountRequestSchema,
  CountResponseSchema,
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
      expectTypeOf(typed.countUp).toBeFunction();
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
    test('raw server stream preserves request bytes and ordered responses', async () => {
      const request = create(CountRequestSchema, { limit: 3 });
      const responses = [1, 2, 3].map((value) =>
        create(CountResponseSchema, { value }),
      );
      let received: Uint8Array | undefined;
      const service = ProtoService.define(TestService, {
        countUp: {
          raw: ({ request: bytes, ctx, resWritable }) => {
            received = new Uint8Array(bytes);
            expect(ctx.method).toBe(TestService.method.countUp);
            for (const response of responses)
              resWritable.write(Ok(toBinary(CountResponseSchema, response)));
            resWritable.close();
          },
        },
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

      await expect(client.countUp(request).collect()).resolves.toEqual(
        responses.map(Ok),
      );
      expect(received).toEqual(toBinary(CountRequestSchema, request));
    });

    test('canceling a raw server stream aborts its producer and runs cleanup', async () => {
      const aborted = vi.fn();
      const cleaned = vi.fn();
      const service = ProtoService.define(TestService, {
        countUp: {
          raw: ({ ctx, resWritable }) => {
            ctx.signal.addEventListener('abort', aborted);
            ctx.deferCleanup(cleaned);
            resWritable.write(
              Ok(
                toBinary(
                  CountResponseSchema,
                  create(CountResponseSchema, { value: 1 }),
                ),
              ),
            );
          },
        },
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
      await waitFor(() => expect(aborted).toHaveBeenCalledOnce());
      await waitFor(() => expect(cleaned).toHaveBeenCalledOnce());
    });
  },
);
