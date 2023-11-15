import http from 'http';
import { bench, describe } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  onServerReady,
} from '../testUtils';
import largePayload from './largePayload.json';
import { TestServiceConstructor } from './integration.test';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import { StupidlyLargeService } from './typescript-stress.test';
import { waitForMessage } from '../transport';

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
  const serviceDefs = { test: TestServiceConstructor() };
  const server = await createServer(serverTransport, serviceDefs);
  const client = createClient<typeof server>(clientTransport);

  bench(
    'rpc (wait for response)',
    async () => {
      await client.test.add({ n: 1 });
    },
    { time: BENCH_DURATION },
  );

  const [input, output] = await client.test.echo();
  bench(
    'stream (wait for response)',
    async () => {
      input.push({ msg: 'abc', ignore: false });
      await output.next();
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
  const serviceDefs = {
    a: StupidlyLargeService(),
    b: StupidlyLargeService(),
    c: StupidlyLargeService(),
    d: StupidlyLargeService(),
  };

  const server = await createServer(serverTransport, serviceDefs);
  const client = createClient<typeof server>(clientTransport);

  bench(
    'rpc (wait for response)',
    async () => {
      await client.b.f35({ a: 1 });
    },
    { time: BENCH_DURATION },
  );
});
