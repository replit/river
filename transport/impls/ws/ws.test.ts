import http from 'http';
import {
  describe,
  test,
  expect,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  createDummyTransportMessage,
  onServerReady,
  createLocalWebSocketClient,
} from '../../../util/testHelpers';
import { msg, waitForMessage } from '../..';
import { WebSocketServerTransport } from './server';
import { WebSocketClientTransport } from './client';
import { ensureTransportIsClean } from '../../../__tests__/fixtures/cleanup';

describe('sending and receiving across websockets works', async () => {
  const server = http.createServer();
  const port = await onServerReady(server);
  const wss = await createWebSocketServer(server);

  afterAll(() => {
    wss.close();
    server.close();
  });

  test('basic send/receive', async () => {
    const [clientTransport, serverTransport] = createWsTransports(port, wss);
    const msg = createDummyTransportMessage();
    clientTransport.send(msg);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg.id),
    ).resolves.toStrictEqual(msg.payload);

    await clientTransport.close();
    await serverTransport.close();
    ensureTransportIsClean(clientTransport);
    ensureTransportIsClean(serverTransport);
  });

  test('sending respects to/from fields', async () => {
    const makeDummyMessage = (from: string, to: string, message: string) => {
      return msg(from, to, 'service', 'proc', 'stream', {
        msg: message,
      });
    };

    const clientId1 = 'client1';
    const clientId2 = 'client2';
    const serverId = 'SERVER';
    const serverTransport = new WebSocketServerTransport(wss, serverId);

    const initClient = async (id: string) => {
      const client = new WebSocketClientTransport(
        () => createLocalWebSocketClient(port),
        id,
        'SERVER',
      );
      const initMsg = makeDummyMessage(id, serverId, 'hello server');
      client.send(initMsg);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === initMsg.id),
      ).resolves.toStrictEqual(initMsg.payload);
      return client;
    };

    const client1 = await initClient(clientId1);
    const client2 = await initClient(clientId2);

    // sending messages from server to client shouldn't leak between clients
    const msg1 = makeDummyMessage('SERVER', 'client1', 'hello client1');
    const msg2 = makeDummyMessage('SERVER', 'client2', 'hello client1');
    const promises = Promise.all([
      // true means reject if we receive any message that isn't the one we are expecting
      waitForMessage(client2, (recv) => recv.id === msg2.id, true),
      waitForMessage(client1, (recv) => recv.id === msg1.id, true),
    ]);
    serverTransport.send(msg1);
    serverTransport.send(msg2);
    await expect(promises).resolves.toStrictEqual([msg1.payload, msg2.payload]);
  });
});

describe('retry logic', async () => {
  const server = http.createServer();
  const port = await onServerReady(server);
  const wss = await createWebSocketServer(server);
  let clientTransport: WebSocketClientTransport;
  let serverTransport: WebSocketServerTransport;

  beforeEach(() => {
    [clientTransport, serverTransport] = createWsTransports(port, wss);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
    ensureTransportIsClean(clientTransport);
    ensureTransportIsClean(serverTransport);
  });

  afterAll(() => {
    wss.close();
    server.close();
  });

  // TODO: right now, we only test client-side disconnects, we probably
  // need to also write tests for server-side crashes (but this involves clearing/restoring state)
  // not going to worry about this rn but for future

  test('ws transport is recreated after clean disconnect', async () => {
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    clientTransport.send(msg1);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg1.id),
    ).resolves.toStrictEqual(msg1.payload);

    clientTransport.connections.forEach((conn) => conn.ws.close());
    clientTransport.send(msg2);
    return expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg2.id),
    ).resolves.toStrictEqual(msg2.payload);
  });

  test('ws transport is recreated after unclean disconnect', async () => {
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    clientTransport.send(msg1);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg1.id),
    ).resolves.toStrictEqual(msg1.payload);

    clientTransport.connections.forEach((conn) => conn.ws.terminate());
    clientTransport.send(msg2);
    return expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg2.id),
    ).resolves.toStrictEqual(msg2.payload);
  });

  test('ws transport is not recreated after destroy', async () => {
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    clientTransport.send(msg1);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg1.id),
    ).resolves.toStrictEqual(msg1.payload);

    clientTransport.destroy();
    return expect(() => clientTransport.send(msg2)).toThrow(
      new Error('transport is destroyed, cant send'),
    );
  });
});
