import { describe, test, expect, afterAll, vi, beforeEach } from 'vitest';
import { Connection, Transport } from '.';
import http from 'http';
import fs from 'fs';
import {
  createDummyTransportMessage,
  createWebSocketServer,
  createWsTransports,
  getUnixSocketPath,
  onServerReady,
  waitForMessage,
} from '../util/testHelpers';
import { testFinishesCleanly, waitFor } from '../__tests__/fixtures/cleanup';
import { EventMap } from './events';
import { UnixDomainSocketServerTransport } from './impls/unixsocket/server';
import { UnixDomainSocketClientTransport } from './impls/unixsocket/client';

const transports: Array<{
  name: string;
  setup: () => Promise<{
    // client, server
    getTransports: () => [Transport<Connection>, Transport<Connection>];
    before?: () => Promise<void>;
    cleanup: () => Promise<void>;
  }>;
}> = [
  {
    name: 'ws',
    setup: async () => {
      const server = http.createServer();
      const port = await onServerReady(server);
      const wss = await createWebSocketServer(server);
      const cleanup = async () => {
        wss.close();
        server.close();
      };
      return {
        getTransports: () => createWsTransports(port, wss),
        cleanup,
      };
    },
  },
  {
    name: 'unix sockets',
    setup: async () => {
      let socketPath: string;
      return {
        before: async () => {
          socketPath = getUnixSocketPath();
        },
        cleanup: async () => {
          if (fs.existsSync(socketPath)) {
            await fs.promises.unlink(socketPath);
          }
        },
        getTransports: () => [
          new UnixDomainSocketClientTransport(socketPath, 'client', 'SERVER'),
          new UnixDomainSocketServerTransport(socketPath, 'SERVER'),
        ],
      };
    },
  },
];

describe.each(transports)('transport -- $name', async ({ setup }) => {
  const { getTransports, cleanup, before } = await setup();
  beforeEach(async () => {
    if (before) {
      await before();
    }
  });

  afterAll(cleanup);

  test('connection is recreated after clean disconnect', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const msg1Promise = waitForMessage(
      serverTransport,
      (recv) => recv.id === msg1.id,
    );
    clientTransport.send(msg1);
    await expect(msg1Promise).resolves.toStrictEqual(msg1.payload);

    // clean disconnect
    clientTransport.connections.forEach((conn) => conn.close());
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
    const [clientTransport, serverTransport] = getTransports();
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
    clientTransport.connections.forEach((conn) => conn.close());

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
    const [clientTransport, serverTransport] = getTransports();
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
