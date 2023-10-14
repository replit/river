import http from 'http';
import { bench, describe } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  onServerReady,
  waitForMessage,
} from '../transport/util';
import largePayload from './largePayload.json';
import { TestServiceConstructor } from './integration.test';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import { StupidlyLargeService } from './typescript-stress.test';

let smallId = 0;
let largeId = 0;
const dummyPayloadSmall = () => ({
  id: `${smallId++}`,
  from: 'client',
  to: 'SERVER',
  serviceName: 'test',
  procedureName: 'test',
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
  payload: largePayload,
});

describe('transport level bandwidth', async () => {
  const port = 4444;
  const server = http.createServer();
  await onServerReady(server, port);
  const webSocketServer = await createWebSocketServer(server);
  const [clientTransport, serverTransport] = await createWsTransports(
    port,
    webSocketServer,
  );

  bench('send and recv (small payload)', async () => {
    const id = clientTransport.send(dummyPayloadSmall());
    await waitForMessage(serverTransport, (msg) => msg.id === id);
    return;
  });

  bench('send and recv (large payload)', async () => {
    const id = clientTransport.send(dummyPayloadLarge());
    await waitForMessage(serverTransport, (msg) => msg.id === id);
    return;
  });
});

describe('simple router level bandwidth', async () => {
  const port = 4445;
  const httpServer = http.createServer();
  await onServerReady(httpServer, port);
  const webSocketServer = await createWebSocketServer(httpServer);
  const [clientTransport, serverTransport] = await createWsTransports(
    port,
    webSocketServer,
  );
  const serviceDefs = { test: TestServiceConstructor() };
  const server = await createServer(serverTransport, serviceDefs);
  const client = createClient<typeof server>(clientTransport);

  bench('rpc (wait for response)', async () => {
    await client.test.add({ n: 1 });
  });

  const [input, output] = await client.test.echo();
  bench('stream (wait for response)', async () => {
    input.push({ msg: 'abc', ignore: false });
    await output.next();
  });

  bench('stream', async () => {
    input.push({ msg: 'abc', ignore: false });
  });
});

describe('complex (50 procedures) router level bandwidth', async () => {
  const port = 4446;
  const httpServer = http.createServer();
  await onServerReady(httpServer, port);
  const webSocketServer = await createWebSocketServer(httpServer);
  const [clientTransport, serverTransport] = await createWsTransports(
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

  bench('rpc (wait for response)', async () => {
    await client.b.f35({ a: 1 });
  });
});
