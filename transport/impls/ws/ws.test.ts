import http from 'http';
import { describe, test, expect, afterAll } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  createDummyTransportMessage,
  onServerReady,
  createLocalWebSocketClient,
  waitForMessage,
} from '../../../util/testHelpers';
import { msg } from '../..';
import { WebSocketServerTransport } from './server';
import { WebSocketClientTransport } from './client';
import { testFinishesCleanly } from '../../../__tests__/fixtures/cleanup';

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
    const msgPromise = waitForMessage(
      serverTransport,
      (recv) => recv.id === msg.id,
    );
    clientTransport.send(msg);
    await expect(msgPromise).resolves.toStrictEqual(msg.payload);

    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });

  test('sending respects to/from fields', async () => {
    const makeDummyMessage = (from: string, to: string, message: string) => {
      return msg(
        from,
        to,
        'stream',
        {
          msg: message,
        },
        'service',
        'proc',
      );
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

      // client to server
      const initMsg = makeDummyMessage(id, serverId, 'hello server');
      const initMsgPromise = waitForMessage(
        serverTransport,
        (recv) => recv.id === initMsg.id,
      );
      client.send(initMsg);
      await expect(initMsgPromise).resolves.toStrictEqual(initMsg.payload);
      return client;
    };

    const client1 = await initClient(clientId1);
    const client2 = await initClient(clientId2);

    // sending messages from server to client shouldn't leak between clients
    const msg1 = makeDummyMessage(serverId, clientId1, 'hello client1');
    const msg2 = makeDummyMessage(serverId, clientId2, 'hello client2');
    const promises = Promise.all([
      // true means reject if we receive any message that isn't the one we are expecting
      waitForMessage(client2, (recv) => recv.id === msg2.id, true),
      waitForMessage(client1, (recv) => recv.id === msg1.id, true),
    ]);
    serverTransport.send(msg1);
    serverTransport.send(msg2);
    await expect(promises).resolves.toStrictEqual(
      expect.arrayContaining([msg1.payload, msg2.payload]),
    );

    await testFinishesCleanly({
      clientTransports: [client1, client2],
      serverTransport,
    });
  });
});

describe('reconnect', async () => {
  const server = http.createServer();
  const port = await onServerReady(server);
  const wss = await createWebSocketServer(server);

  afterAll(() => {
    wss.close();
    server.close();
  });

  test('ws connection is recreated after unclean disconnect', async () => {
    const [clientTransport, serverTransport] = createWsTransports(port, wss);
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const msg1Promise = waitForMessage(
      serverTransport,
      (recv) => recv.id === msg1.id,
    );
    clientTransport.send(msg1);
    await expect(msg1Promise).resolves.toStrictEqual(msg1.payload);

    // unclean disconnect
    clientTransport.connections.forEach((conn) => conn.ws.terminate());
    const msg2Promise = waitForMessage(
      serverTransport,
      (recv) => recv.id === msg2.id,
    );

    // by this point the client should have reconnected
    clientTransport.send(msg2);
    await expect(msg2Promise).resolves.toStrictEqual(msg2.payload);
    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });
});
