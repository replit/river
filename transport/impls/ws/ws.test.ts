import http from 'http';
import { describe, test, expect, afterAll, vi } from 'vitest';
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
import {
  testFinishesCleanly,
  waitFor,
} from '../../../__tests__/fixtures/cleanup';
import { EventMap } from '../../events';

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
      (recv) => recv.id === msg1.id,
    );
    clientTransport.send(msg1);
    await expect(msg1Promise).resolves.toStrictEqual(msg1.payload);

    // clean disconnect
    clientTransport.connections.forEach((conn) => conn.ws.close());
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

  test('both client and server transport gets connection and disconnection notifs', async () => {
    const [clientTransport, serverTransport] = createWsTransports(port, wss);
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const onClientConnect = vi.fn();
    const onClientDisconnect = vi.fn();
    const clientHandler = (evt: EventMap['connectionStatus']) => {
      if (evt.conn.connectedTo !== serverTransport.clientId) return;
      if (evt.status === 'connect') return onClientConnect();
      if (evt.status === 'disconnect') return onClientDisconnect();
    };

    const onServerConnect = vi.fn();
    const onServerDisconnect = vi.fn();
    const serverHandler = (evt: EventMap['connectionStatus']) => {
      if (
        evt.status === 'connect' &&
        evt.conn.connectedTo === clientTransport.clientId
      )
        return onServerConnect();
      if (
        evt.status === 'disconnect' &&
        evt.conn.connectedTo === clientTransport.clientId
      )
        return onServerDisconnect();
    };

    clientTransport.addEventListener('connectionStatus', clientHandler);
    serverTransport.addEventListener('connectionStatus', serverHandler);

    expect(onClientConnect).toHaveBeenCalledTimes(0);
    expect(onClientDisconnect).toHaveBeenCalledTimes(0);
    expect(onServerConnect).toHaveBeenCalledTimes(0);
    expect(onServerDisconnect).toHaveBeenCalledTimes(0);

    const msg1Promise = waitForMessage(
      serverTransport,
      (recv) => recv.id === msg1.id,
    );
    clientTransport.send(msg1);
    await expect(msg1Promise).resolves.toStrictEqual(msg1.payload);

    expect(onClientConnect).toHaveBeenCalledTimes(1);
    expect(onClientDisconnect).toHaveBeenCalledTimes(0);
    expect(onServerConnect).toHaveBeenCalledTimes(1);
    expect(onServerDisconnect).toHaveBeenCalledTimes(0);

    // clean disconnect
    clientTransport.connections.forEach((conn) => conn.ws.close());

    // wait for connection status to propagate to server
    await waitFor(() => expect(onClientConnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClientDisconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onServerConnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onServerDisconnect).toHaveBeenCalledTimes(1));

    const msg2Promise = waitForMessage(
      serverTransport,
      (recv) => recv.id === msg2.id,
    );

    // by this point the client should have reconnected
    clientTransport.send(msg2);
    await expect(msg2Promise).resolves.toStrictEqual(msg2.payload);
    expect(onClientConnect).toHaveBeenCalledTimes(2);
    expect(onClientDisconnect).toHaveBeenCalledTimes(1);
    expect(onServerConnect).toHaveBeenCalledTimes(2);
    expect(onServerDisconnect).toHaveBeenCalledTimes(1);

    // teardown
    clientTransport.removeEventListener('connectionStatus', clientHandler);
    serverTransport.removeEventListener('connectionStatus', serverHandler);
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
