import http from 'node:http';
import { describe, test, expect, afterAll } from 'vitest';
import {
  createWebSocketServer,
  onWsServerReady,
  createLocalWebSocketClient,
  waitForMessage,
  createDummyTransportMessage,
  payloadToTransportMessage,
} from '../../../util/testHelpers';
import { WebSocketServerTransport } from './server';
import { WebSocketClientTransport } from './client';
import { testFinishesCleanly } from '../../../__tests__/fixtures/cleanup';
import { PartialTransportMessage } from '../../message';

describe('sending and receiving across websockets works', async () => {
  const server = http.createServer();
  const port = await onWsServerReady(server);
  const wss = await createWebSocketServer(server);

  afterAll(() => {
    wss.close();
    server.close();
  });

  test('basic send/receive', async () => {
    const clientTransport = new WebSocketClientTransport(
      () => createLocalWebSocketClient(port),
      'client',
      'SERVER',
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    const msg = createDummyTransportMessage();
    const msgId = clientTransport.send(serverTransport.clientId, msg);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msgId),
    ).resolves.toStrictEqual(msg.payload);

    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });

  test('sending respects to/from fields', async () => {
    const makeDummyMessage = (message: string): PartialTransportMessage => {
      return payloadToTransportMessage({ message });
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
      const initMsg = makeDummyMessage('hello server');
      const initMsgId = client.send(serverId, initMsg);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === initMsgId),
      ).resolves.toStrictEqual(initMsg.payload);
      return client;
    };

    const client1 = await initClient(clientId1);
    const client2 = await initClient(clientId2);

    // sending messages from server to client shouldn't leak between clients
    const msg1 = makeDummyMessage('hello client1');
    const msg2 = makeDummyMessage('hello client2');
    const msg1Id = serverTransport.send(clientId1, msg1);
    const msg2Id = serverTransport.send(clientId2, msg2);
    const promises = Promise.all([
      // true means reject if we receive any message that isn't the one we are expecting
      waitForMessage(client2, (recv) => recv.id === msg2Id, true),
      waitForMessage(client1, (recv) => recv.id === msg1Id, true),
    ]);
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
  const port = await onWsServerReady(server);
  const wss = await createWebSocketServer(server);

  afterAll(() => {
    wss.close();
    server.close();
  });

  test('ws connection is recreated after unclean disconnect', async () => {
    const clientTransport = new WebSocketClientTransport(
      () => createLocalWebSocketClient(port),
      'client',
      'SERVER',
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
    ).resolves.toStrictEqual(msg1.payload);

    // unclean disconnect
    clientTransport.sessions.forEach(
      (session) => session.connection?.ws.terminate(),
    );

    // by this point the client should have reconnected
    const msg2Id = clientTransport.send(serverTransport.clientId, msg2);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg2Id),
    ).resolves.toStrictEqual(msg2.payload);

    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });
});
