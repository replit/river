/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BinaryCodec, NaiveJsonCodec } from '../codec';
import {
  type ClientError,
  Err,
  type Middleware,
  Ok,
  ProtoCodec,
  ReadableBrokenError,
  RiverErrorCode,
  createClient,
  createClientHandshakeOptions,
  createProtoService,
  createServer,
  createServerHandshakeOptions,
  UNEXPECTED_DISCONNECT_CODE,
} from '../protobuf';
import {
  cleanupTransports,
  createPostTestCleanups,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import {
  type TestSetupHelpers,
  transports,
} from '../testUtil/fixtures/transports';
import {
  AuthHandshakeSchema,
  TestService,
} from '../testUtil/fixtures/protobuf';

const protobufRouterMatrix = transports.flatMap((transport) =>
  [
    { name: 'naive', codec: NaiveJsonCodec },
    { name: 'binary', codec: BinaryCodec },
    { name: 'proto', codec: ProtoCodec },
  ].map((codec) => ({ transport, codec })),
);

function coerceReadableError(
  error: ClientError | typeof ReadableBrokenError,
): ClientError {
  return error.code === ReadableBrokenError.code
    ? { code: UNEXPECTED_DISCONNECT_CODE, message: error.message }
    : error;
}

const ProtoService = createProtoService();

describe.each(protobufRouterMatrix)(
  'protobuf router ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };
    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];

    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    test('unary call and returned unary error', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const testSvc = ProtoService.define(TestService, {
        echo: (request, ctx) => {
          if (request.text === 'boom') {
            return Err({
              code: RiverErrorCode.INVALID_ARGUMENT,
              message: `bad input from ${ctx.from}`,
            });
          }

          return Ok({ text: request.text.toUpperCase() });
        },
      });
      const server = createServer(serverTransport, [testSvc]);
      addPostTestCleanup(async () => {
        await waitFor(() => expect(server.streams).toStrictEqual(new Map()));
        await server.close();
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const client = createClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
      );

      await expect(client.echo({ text: 'hello' })).resolves.toMatchObject({
        ok: true,
        payload: {
          text: 'HELLO',
        },
      });
      await expect(client.echo({ text: 'boom' })).resolves.toMatchObject({
        ok: false,
        payload: {
          code: RiverErrorCode.INVALID_ARGUMENT,
          message: `bad input from ${clientTransport.clientId}`,
        },
      });
    });

    test('unary call can use ctx.cancel', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const testSvc = ProtoService.define(TestService, {
        echo: (_request, ctx) => ctx.cancel('cancelled by handler'),
      });
      const server = createServer(serverTransport, [testSvc]);
      addPostTestCleanup(async () => {
        await waitFor(() => expect(server.streams).toStrictEqual(new Map()));
        await server.close();
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const client = createClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
      );

      await expect(client.echo({ text: 'hello' })).resolves.toMatchObject({
        ok: false,
        payload: {
          code: 'CANCEL',
          message: 'cancelled by handler',
        },
      });
    });

    test('server streaming returns decoded protobuf messages', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const testSvc = ProtoService.define(TestService, {
        countUp: async (param) => {
          for (let value = 1; value <= param.request.limit; value++) {
            param.resWritable.write(Ok({ value }));
          }

          param.resWritable.close();
        },
      });
      const server = createServer(serverTransport, [testSvc]);
      addPostTestCleanup(async () => {
        await waitFor(() => expect(server.streams).toStrictEqual(new Map()));
        await server.close();
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const client = createClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
      );

      const results = await client.countUp({ limit: 3 }).collect();
      expect(results).toStrictEqual([
        {
          ok: true,
          payload: { $typeName: 'river.test.CountResponse', value: 1 },
        },
        {
          ok: true,
          payload: { $typeName: 'river.test.CountResponse', value: 2 },
        },
        {
          ok: true,
          payload: { $typeName: 'river.test.CountResponse', value: 3 },
        },
      ]);
    });

    test('client streaming finalizes to a unary protobuf response', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const testSvc = ProtoService.define(TestService, {
        sum: async ({ reqReadable }) => {
          let total = 0;
          for (const result of await reqReadable.collect()) {
            if (!result.ok) {
              return Err(coerceReadableError(result.payload));
            }

            total += result.payload.value;
          }

          return Ok({ total });
        },
      });
      const server = createServer(serverTransport, [testSvc]);
      addPostTestCleanup(async () => {
        await waitFor(() => expect(server.streams).toStrictEqual(new Map()));
        await server.close();
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const client = createClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
      );
      const call = client.sum();
      call.reqWritable.write({ value: 1 });
      call.reqWritable.write({ value: 2 });
      call.reqWritable.write({ value: 3 });

      await expect(call.finalize()).resolves.toMatchObject({
        ok: true,
        payload: {
          total: 6,
        },
      });
    });

    test('bidi streaming surfaces returned Err values on the readable error channel', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const testSvc = ProtoService.define(TestService, {
        chat: async (param) => {
          for (const result of await param.reqReadable.collect()) {
            if (!result.ok) {
              param.resWritable.write(Err(coerceReadableError(result.payload)));
              param.resWritable.close();

              return;
            }

            if (result.payload.text === 'boom') {
              param.resWritable.write(
                Err({
                  code: RiverErrorCode.INVALID_ARGUMENT,
                  message: 'boom is not allowed',
                }),
              );
              param.resWritable.close();

              return;
            }

            param.resWritable.write(
              Ok({ text: result.payload.text.toUpperCase() }),
            );
          }

          param.resWritable.close();
        },
      });
      const server = createServer(serverTransport, [testSvc]);
      addPostTestCleanup(async () => {
        await waitFor(() => expect(server.streams).toStrictEqual(new Map()));
        await server.close();
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const client = createClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
      );
      const call = client.chat();
      const iterator = call.resReadable[Symbol.asyncIterator]();

      call.reqWritable.write({ text: 'hello' });
      call.reqWritable.write({ text: 'boom' });
      call.reqWritable.close();

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          ok: true,
          payload: {
            $typeName: 'river.test.ChatMessage',
            text: 'HELLO',
          },
        },
      });
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          ok: false,
          payload: {
            code: RiverErrorCode.INVALID_ARGUMENT,
            message: 'boom is not allowed',
          },
        },
      });
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
    });

    test('protobuf handshake metadata is decoded through the router helpers', async () => {
      const clientHandshakeOptions = createClientHandshakeOptions(
        AuthHandshakeSchema,
        () => ({ token: 'let-me-in' }),
      );
      const serverHandshakeOptions = createServerHandshakeOptions(
        AuthHandshakeSchema,
        (metadata) => ({
          token: metadata.token,
        }),
      );

      const clientTransport = getClientTransport(
        'client',
        clientHandshakeOptions,
      );
      const serverTransport = getServerTransport(
        'SERVER',
        serverHandshakeOptions,
      );
      const TypedProtoService = createProtoService<object, { token: string }>();
      const testSvc = TypedProtoService.define(TestService, {
        echo: (request, ctx) =>
          Ok({ text: `${ctx.metadata.token}:${request.text}` }),
      });
      const server = createServer(serverTransport, [testSvc], {
        handshakeOptions: serverHandshakeOptions,
      });
      addPostTestCleanup(async () => {
        await waitFor(() => expect(server.streams).toStrictEqual(new Map()));
        await server.close();
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const client = createClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
      );

      await expect(client.echo({ text: 'hello' })).resolves.toMatchObject({
        ok: true,
        payload: {
          text: 'let-me-in:hello',
        },
      });
    });

    test('protobuf middleware can inspect unary requests', async () => {
      const middlewareImpl: Middleware = ({ next }) => next();
      const middleware = vi.fn(middlewareImpl);
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const testSvc = ProtoService.define(TestService, {
        echo: (request) => Ok({ text: request.text.toUpperCase() }),
      });
      const server = createServer(serverTransport, [testSvc], {
        middlewares: [middleware],
      });
      addPostTestCleanup(async () => {
        await waitFor(() => expect(server.streams).toStrictEqual(new Map()));
        await server.close();
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const client = createClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
      );

      await expect(client.echo({ text: 'hello' })).resolves.toMatchObject({
        ok: true,
        payload: {
          text: 'HELLO',
        },
      });

      expect(middleware).toHaveBeenCalledOnce();
      const firstCall = middleware.mock.calls[0][0];
      expect(firstCall).toMatchObject({
        ctx: {
          service: TestService,
          method: TestService.method.echo,
          serviceName: TestService.typeName,
          procedureName: TestService.method.echo.name,
        },
        reqInit: {
          text: 'hello',
        },
      });
      expect(firstCall.ctx.sessionId).toEqual(
        expect.stringContaining('session-'),
      );
      expect(firstCall.ctx.span).toBeDefined();
      expect(firstCall.ctx.streamId).toEqual(expect.any(String));
      expect(firstCall.ctx.signal).toBeDefined();
      expect(firstCall.next).toEqual(expect.any(Function));
    });
  },
);
