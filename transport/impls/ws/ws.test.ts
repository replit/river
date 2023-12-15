import http from 'http';
import { describe, test, expect, afterAll, vi } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  createDummyTransportMessage,
  onServerReady,
  createLocalWebSocketClient,
} from '../../../util/testHelpers';
import { CONNECTION_GRACE_PERIOD_MS, msg, waitForMessage } from '../..';
import { WebSocketServerTransport } from './server';
import { WebSocketClientTransport } from './client';
import { testFinishesCleanly } from '../../../__tests__/fixtures/cleanup';
import { Err } from '../../../router';
import { UNEXPECTED_DISCONNECT } from '../../../router/result';

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
      clientTransport.clientId,
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
      const initMsg = makeDummyMessage(id, serverId, 'hello server');
      const initMsgPromise = waitForMessage(
        serverTransport,
        id,
        (recv) => recv.id === initMsg.id,
      );
      client.send(initMsg);
      await expect(initMsgPromise).resolves.toStrictEqual(initMsg.payload);
      return client;
    };

    const client1 = await initClient(clientId1);
    const client2 = await initClient(clientId2);

    // sending messages from server to client shouldn't leak between clients
    const msg1 = makeDummyMessage('SERVER', 'client1', 'hello client1');
    const msg2 = makeDummyMessage('SERVER', 'client2', 'hello client1');
    const promises = Promise.all([
      // true means reject if we receive any message that isn't the one we are expecting
      waitForMessage(client2, serverId, (recv) => recv.id === msg2.id, true),
      waitForMessage(client1, serverId, (recv) => recv.id === msg1.id, true),
    ]);
    serverTransport.send(msg1);
    serverTransport.send(msg2);
    await expect(promises).resolves.toStrictEqual([msg1.payload, msg2.payload]);

    await testFinishesCleanly({
      clientTransports: [client1, client2],
      serverTransport,
    });
  });
});

describe('retry logic', async () => {
  const server = http.createServer();
  const port = await onServerReady(server);
  const wss = await createWebSocketServer(server);

  afterAll(() => {
    wss.close();
    server.close();
  });

  // TODO: right now, we only test client-side disconnects, we probably
  // need to also write tests for server-side crashes (but this involves clearing/restoring state)
  // not going to worry about this rn but for future

  test('ws connection is recreated after clean disconnect', async () => {
    const [clientTransport, serverTransport] = createWsTransports(port, wss);
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const msg1Promise = waitForMessage(
      serverTransport,
      clientTransport.clientId,
      (recv) => recv.id === msg1.id,
    );
    clientTransport.send(msg1);
    await expect(msg1Promise).resolves.toStrictEqual(msg1.payload);

    // clean disconnect
    clientTransport.connections.forEach((conn) => conn.ws.close());
    const msg2Promise = waitForMessage(
      serverTransport,
      clientTransport.clientId,
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

  test('ws connection is recreated after unclean disconnect', async () => {
    const [clientTransport, serverTransport] = createWsTransports(port, wss);
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const msg1Promise = waitForMessage(
      serverTransport,
      clientTransport.clientId,
      (recv) => recv.id === msg1.id,
    );
    clientTransport.send(msg1);
    await expect(msg1Promise).resolves.toStrictEqual(msg1.payload);

    // unclean disconnect
    clientTransport.connections.forEach((conn) => conn.ws.terminate());
    const msg2Promise = waitForMessage(
      serverTransport,
      clientTransport.clientId,
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

  test('client rpc is notified after disconnect grace period expires', async () => {
    vi.useFakeTimers();
    const [clientTransport, serverTransport] = createWsTransports(port, wss);
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const msg1Promise = waitForMessage(
      serverTransport,
      clientTransport.clientId,
      (recv) => recv.id === msg1.id,
    );
    clientTransport.send(msg1);
    await expect(msg1Promise).resolves.toStrictEqual(msg1.payload);

    // simulate disconnecting mid-rpc
    const msg2Promise = waitForMessage(
      serverTransport,
      clientTransport.clientId,
      (recv) => recv.id === msg2.id,
    );
    clientTransport.connections.forEach((conn) => conn.ws.terminate());
    clientTransport.tryReconnecting = false;
    clientTransport.send(msg2);

    // hit out connection grace period timeout
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(CONNECTION_GRACE_PERIOD_MS);

    await expect(msg2Promise).resolves.toMatchObject(
      Err({
        code: UNEXPECTED_DISCONNECT,
      }),
    );

    vi.useRealTimers();
    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });

  test('ws connection is not recreated after destroy', async () => {
    const [clientTransport, serverTransport] = createWsTransports(port, wss);
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const promise1 = waitForMessage(
      serverTransport,
      clientTransport.clientId,
      (recv) => recv.id === msg1.id,
    );
    clientTransport.send(msg1);
    await expect(promise1).resolves.toStrictEqual(msg1.payload);

    clientTransport.destroy();
    expect(() => clientTransport.send(msg2)).toThrow(
      new Error('transport is destroyed, cant send'),
    );

    // this is not expected to be clean because we destroyed the transport
    expect(clientTransport.state).toEqual('destroyed');
    await clientTransport.close();
    await serverTransport.close();
  });
});
