import http from 'http';
import { Type } from '@sinclair/typebox';
import { ServiceBuilder, serializeService } from '../router/builder';
import { reply } from '../transport/message';
import { afterAll, describe, expect, test } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  onServerReady,
  asClientRpc,
  asClientStream,
} from '../testUtils';
import { createServer } from '../router/server';
import { createClient } from '../router/client';

export const EchoRequest = Type.Object({
  msg: Type.String(),
  ignore: Type.Boolean(),
});
export const EchoResponse = Type.Object({ response: Type.String() });

export const TestServiceConstructor = () =>
  ServiceBuilder.create('test')
    .initialState({
      count: 0,
    })
    .defineProcedure('add', {
      type: 'rpc',
      input: Type.Object({ n: Type.Number() }),
      output: Type.Object({ result: Type.Number() }),
      async handler(ctx, msg) {
        const { n } = msg.payload;
        ctx.state.count += n;
        return reply(msg, { result: ctx.state.count });
      },
    })
    .defineProcedure('echo', {
      type: 'stream',
      input: EchoRequest,
      output: EchoResponse,
      async handler(_ctx, msgStream, returnStream) {
        for await (const msg of msgStream) {
          const req = msg.payload;
          if (!req.ignore) {
            returnStream.push(reply(msg, { response: req.msg }));
          }
        }
      },
    })
    .finalize();

const OrderingServiceConstructor = () =>
  ServiceBuilder.create('test')
    .initialState({
      msgs: [] as number[],
    })
    .defineProcedure('add', {
      type: 'rpc',
      input: Type.Object({ n: Type.Number() }),
      output: Type.Object({ ok: Type.Boolean() }),
      async handler(ctx, msg) {
        const { n } = msg.payload;
        ctx.state.msgs.push(n);
        return reply(msg, { ok: true });
      },
    })
    .defineProcedure('getAll', {
      type: 'rpc',
      input: Type.Object({}),
      output: Type.Object({ msgs: Type.Array(Type.Number()) }),
      async handler(ctx, msg) {
        return reply(msg, { msgs: ctx.state.msgs });
      },
    })
    .finalize();

test('serialize service to jsonschema', () => {
  const service = TestServiceConstructor();
  expect(serializeService(service)).toStrictEqual({
    name: 'test',
    state: { count: 0 },
    procedures: {
      add: {
        input: {
          properties: {
            n: { type: 'number' },
          },
          required: ['n'],
          type: 'object',
        },
        output: {
          properties: {
            result: { type: 'number' },
          },
          required: ['result'],
          type: 'object',
        },
        type: 'rpc',
      },
      echo: {
        input: {
          properties: {
            msg: { type: 'string' },
            ignore: { type: 'boolean' },
          },
          required: ['msg', 'ignore'],
          type: 'object',
        },
        output: {
          properties: {
            response: { type: 'string' },
          },
          required: ['response'],
          type: 'object',
        },
        type: 'stream',
      },
    },
  });
});

describe('server-side test', () => {
  const service = TestServiceConstructor();
  const initialState = { count: 0 };

  test('rpc basic', async () => {
    const add = asClientRpc(initialState, service.procedures.add);
    await expect(add({ n: 3 })).resolves.toStrictEqual({ result: 3 });
  });

  test('rpc initial state', async () => {
    const add = asClientRpc({ count: 5 }, service.procedures.add);
    await expect(add({ n: 6 })).resolves.toStrictEqual({ result: 11 });
  });

  test('stream basic', async () => {
    const [input, output] = asClientStream(
      initialState,
      service.procedures.echo,
    );

    input.push({ msg: 'abc', ignore: false });
    input.push({ msg: 'def', ignore: true });
    input.push({ msg: 'ghi', ignore: false });
    input.end();

    await expect(output.next().then((res) => res.value)).resolves.toStrictEqual(
      {
        response: 'abc',
      },
    );
    await expect(output.next().then((res) => res.value)).resolves.toStrictEqual(
      {
        response: 'ghi',
      },
    );
    expect(output.readableLength).toBe(0);
  });
});

describe('client <-> server integration test', async () => {
  const server = http.createServer();
  const port = await onServerReady(server);
  const webSocketServer = await createWebSocketServer(server);

  afterAll(() => {
    webSocketServer.clients.forEach((socket) => {
      socket.close();
    });
    server.close();
  });

  test('rpc', async () => {
    const [clientTransport, serverTransport] = createWsTransports(
      port,
      webSocketServer,
    );
    const serviceDefs = { test: TestServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);
    await expect(client.test.add({ n: 3 })).resolves.toStrictEqual({
      result: 3,
    });
  });

  test('stream', async () => {
    const [clientTransport, serverTransport] = createWsTransports(
      port,
      webSocketServer,
    );
    const serviceDefs = { test: TestServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    const [input, output, close] = await client.test.echo();
    input.push({ msg: 'abc', ignore: false });
    input.push({ msg: 'def', ignore: true });
    input.push({ msg: 'ghi', ignore: false });
    input.end();

    await expect(output.next().then((res) => res.value)).resolves.toStrictEqual(
      {
        response: 'abc',
      },
    );
    await expect(output.next().then((res) => res.value)).resolves.toStrictEqual(
      {
        response: 'ghi',
      },
    );

    close();
  });

  test('message order is preserved in the face of disconnects', async () => {
    const [clientTransport, serverTransport] = createWsTransports(
      port,
      webSocketServer,
    );
    const serviceDefs = { test: OrderingServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    const expected: number[] = [];
    for (let i = 0; i < 50; i++) {
      expected.push(i);

      if (i == 10) {
        clientTransport.ws?.close();
      }

      if (i == 42) {
        clientTransport.ws?.terminate();
      }

      await client.test.add({
        n: i,
      });
    }

    const res = await client.test.getAll({});
    return expect(res.msgs).toStrictEqual(expected);
  });
});
