import http from 'http';
import { WebSocketServer } from 'ws';
import { Type } from '@sinclair/typebox';
import { ServiceBuilder, serializeService } from '../router/builder';
import { reply } from '../transport/message';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  onServerReady,
} from '../transport/util';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import { asClientRpc, asClientStream } from '../router/server.util';

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
      async handler(state, msg) {
        const { n } = msg.payload;
        state.count += n;
        return reply(msg, { result: state.count });
      },
    })
    .defineProcedure('echo', {
      type: 'stream',
      input: EchoRequest,
      output: EchoResponse,
      async handler(_state, msgStream, returnStream) {
        for await (const msg of msgStream) {
          const req = msg.payload;
          if (!req.ignore) {
            returnStream.push(reply(msg, { response: req.msg }));
          }
        }
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
    const [i, o] = asClientStream(initialState, service.procedures.echo);

    i.push({ msg: 'abc', ignore: false });
    i.push({ msg: 'def', ignore: true });
    i.push({ msg: 'ghi', ignore: false });
    i.end();

    await expect(o.next().then((res) => res.value)).resolves.toStrictEqual({
      response: 'abc',
    });
    await expect(o.next().then((res) => res.value)).resolves.toStrictEqual({
      response: 'ghi',
    });
    expect(o.readableLength).toBe(0);
  });
});

const port = 3001;
describe('client <-> server integration test', () => {
  const server = http.createServer();
  let wss: WebSocketServer;

  beforeAll(async () => {
    await onServerReady(server, port);
    wss = await createWebSocketServer(server);
  });

  afterAll(() => {
    wss.clients.forEach((socket) => {
      socket.close();
    });
    server.close();
  });

  test('rpc', async () => {
    const [ct, st] = await createWsTransports(port, wss);
    const serviceDefs = { test: TestServiceConstructor() };
    const server = await createServer(st, serviceDefs);
    const client = createClient<typeof server>(ct);
    await expect(client.test.add({ n: 3 })).resolves.toStrictEqual({
      result: 3,
    });
  });

  test('stream', async () => {
    const [ct, st] = await createWsTransports(port, wss);
    const serviceDefs = { test: TestServiceConstructor() };
    const server = await createServer(st, serviceDefs);
    const client = createClient<typeof server>(ct);

    const [i, o, close] = await client.test.echo();
    i.push({ msg: 'abc', ignore: false });
    i.push({ msg: 'def', ignore: true });
    i.push({ msg: 'ghi', ignore: false });
    i.end();

    await expect(o.next().then((res) => res.value)).resolves.toStrictEqual({
      response: 'abc',
    });
    await expect(o.next().then((res) => res.value)).resolves.toStrictEqual({
      response: 'ghi',
    });
    close();
  });
});
