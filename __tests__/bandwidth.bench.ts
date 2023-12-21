import http from 'node:http';
import { assert, bench, describe } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  onServerReady,
  waitForMessage,
} from '../util/testHelpers';
import largePayload from './fixtures/largePayload.json';
import { TestServiceConstructor } from './fixtures/services';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import { StupidlyLargeService } from './typescript-stress.test';
import { buildServiceDefs } from '../router/defs';

let smallId = 0;
let largeId = 0;
const dummyPayloadSmall = () => ({
  id: `${smallId++}`,
  from: 'client',
  to: 'SERVER',
  serviceName: 'test',
  procedureName: 'test',
  streamId: 'test',
  controlFlags: 0,
  payload: {
    msg: 'cool',
  },
});

const dummyPayloadLarge = () => ({
  id: `${largeId++}`,
  from: 'client',
  to: 'SERVER',
  serviceName: 'test',
  procedureName: 'test',
  streamId: 'test',
  controlFlags: 0,
  payload: largePayload,
});

const BENCH_DURATION = 1000;
describe('transport level bandwidth', async () => {
  const server = http.createServer();
  const port = await onServerReady(server);
  const webSocketServer = await createWebSocketServer(server);
  const [clientTransport, serverTransport] = createWsTransports(
    port,
    webSocketServer,
  );

  bench(
    'send and recv (small payload)',
    async () => {
      const id = clientTransport.send(dummyPayloadSmall());
      await waitForMessage(serverTransport, (msg) => msg.id === id);
      return;
    },
    { time: BENCH_DURATION },
  );

  bench(
    'send and recv (large payload)',
    async () => {
      const id = clientTransport.send(dummyPayloadLarge());
      await waitForMessage(serverTransport, (msg) => msg.id === id);
      return;
    },
    { time: BENCH_DURATION },
  );
});

describe('simple router level bandwidth', async () => {
  const httpServer = http.createServer();
  const port = await onServerReady(httpServer);
  const webSocketServer = await createWebSocketServer(httpServer);
  const [clientTransport, serverTransport] = createWsTransports(
    port,
    webSocketServer,
  );
  const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
  const server = createServer(serverTransport, serviceDefs);
  const client = createClient<typeof server>(clientTransport);

  bench(
    'rpc (wait for response)',
    async () => {
      const result = await client.test.add.rpc({ n: 1 });
      assert(result.ok);
    },
    { time: BENCH_DURATION },
  );

  const [input, output] = await client.test.echo.stream();
  bench(
    'stream (wait for response)',
    async () => {
      input.push({ msg: 'abc', ignore: false });
      const result = await output.next();
      assert(result.value && result.value.ok);
    },
    { time: BENCH_DURATION },
  );

  bench(
    'stream',
    async () => {
      input.push({ msg: 'abc', ignore: false });
    },
    { time: BENCH_DURATION },
  );
});

describe('complex (50 procedures) router level bandwidth', async () => {
  const httpServer = http.createServer();
  const port = await onServerReady(httpServer);
  const webSocketServer = await createWebSocketServer(httpServer);
  const [clientTransport, serverTransport] = createWsTransports(
    port,
    webSocketServer,
  );
  const serviceDefs = buildServiceDefs([
    StupidlyLargeService('a'),
    StupidlyLargeService('b'),
    StupidlyLargeService('c'),
    StupidlyLargeService('d'),
  ]);

  const server = createServer(serverTransport, serviceDefs);
  const client = createClient<typeof server>(clientTransport);

  bench(
    'rpc (wait for response)',
    async () => {
      const result = await client.b.f35.rpc({ a: 1 });
      assert(result.ok);
    },
    { time: BENCH_DURATION },
  );
});
