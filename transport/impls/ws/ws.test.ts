import http from 'node:http';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  createWebSocketServer,
  onWsServerReady,
  waitForMessage,
  createDummyTransportMessage,
  payloadToTransportMessage,
  createLocalWebSocketClient,
} from '../../../util/testHelpers';
import { WebSocketServerTransport } from './server';
import { WebSocketClientTransport } from './client';
import {
  advanceFakeTimersBySessionGrace,
  testFinishesCleanly,
} from '../../../__tests__/fixtures/cleanup';
import { PartialTransportMessage } from '../../message';
import type NodeWs from 'ws';
import { createPostTestChecks } from '../../../__tests__/fixtures/cleanup';

describe('sending and receiving across websockets works', async () => {
  let server: http.Server;
  let port: number;
  let wss: NodeWs.Server;

  const { onTestFinished, postTestChecks } = createPostTestChecks();
  beforeEach(async () => {
    server = http.createServer();
    port = await onWsServerReady(server);
    wss = createWebSocketServer(server);

    return async () => {
      await postTestChecks();
      wss.close();
      server.close();
    };
  });

  test('basic send/receive', async () => {
    const clientTransport = new WebSocketClientTransport(
      () => Promise.resolve(createLocalWebSocketClient(port)),
      'client',
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    await clientTransport.connect(serverTransport.clientId);
    onTestFinished(async () => {
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    const msg = createDummyTransportMessage();
    const msgId = clientTransport.send(serverTransport.clientId, msg);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msgId),
    ).resolves.toStrictEqual(msg.payload);
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
        () => Promise.resolve(createLocalWebSocketClient(port)),
        id,
      );

      // client to server
      await client.connect(serverTransport.clientId);
      const initMsg = makeDummyMessage('hello server');
      const initMsgId = client.send(serverId, initMsg);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === initMsgId),
      ).resolves.toStrictEqual(initMsg.payload);
      return client;
    };

    const client1 = await initClient(clientId1);
    const client2 = await initClient(clientId2);
    onTestFinished(async () => {
      await testFinishesCleanly({
        clientTransports: [client1, client2],
        serverTransport,
      });
    });

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
  });

  test('hanging ws connection with no handshake is cleaned up after grace', async () => {
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    onTestFinished(async () => {
      await testFinishesCleanly({
        clientTransports: [],
        serverTransport,
      });
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ws = createLocalWebSocketClient(port);

    // wait for ws to be open
    await new Promise((resolve) => (ws.onopen = resolve));

    // we never sent a handshake so there should be no connections or sessions
    expect(serverTransport.connections.size).toBe(0);
    expect(serverTransport.sessions.size).toBe(0);

    // advance time past the grace period
    await advanceFakeTimersBySessionGrace();

    // the connection should have been cleaned up
    expect(serverTransport.connections.size).toBe(0);
    expect(serverTransport.sessions.size).toBe(0);
    expect(ws.readyState).toBe(ws.CLOSED);
  });

  test('ws connection is recreated after unclean disconnect', async () => {
    const clientTransport = new WebSocketClientTransport(
      () => Promise.resolve(createLocalWebSocketClient(port)),
      'client',
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    await clientTransport.connect(serverTransport.clientId);
    onTestFinished(async () => {
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
    ).resolves.toStrictEqual(msg1.payload);

    // unclean client disconnect
    clientTransport.sessions.forEach((session) =>
      (session.connection?.ws as NodeWs).terminate(),
    );

    // by this point the client should have reconnected
    const msg2Id = clientTransport.send(serverTransport.clientId, msg2);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg2Id),
    ).resolves.toStrictEqual(msg2.payload);
  });

  test('ws connection always calls the close callback', async () => {
    const clientTransport = new WebSocketClientTransport(
      () => Promise.resolve(createLocalWebSocketClient(port)),
      'client',
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    await clientTransport.connect(serverTransport.clientId);
    onTestFinished(async () => {
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
    ).resolves.toStrictEqual(msg1.payload);

    // unclean server disconnect. Note that the Node implementation sends the reason on the
    // `onclose`, but (some?) browsers call the `onerror` handler before it since it was an unclean
    // exit.
    serverTransport.sessions.forEach((session) =>
      (session.connection?.ws as NodeWs).terminate(),
    );

    // by this point the client should have reconnected
    const msg2Id = clientTransport.send(serverTransport.clientId, msg2);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg2Id),
    ).resolves.toStrictEqual(msg2.payload);
  });
});
