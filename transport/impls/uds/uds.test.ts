import { describe, test, expect, beforeEach } from 'vitest';
import { UnixDomainSocketClientTransport } from './client';
import { UnixDomainSocketServerTransport } from './server';
import {
  getUnixSocketPath,
  numberOfConnections,
  onUdsServeReady,
  payloadToTransportMessage,
  waitForMessage,
} from '../../../util/testHelpers';
import {
  advanceFakeTimersBySessionGrace,
  cleanupTransports,
  testFinishesCleanly,
} from '../../../__tests__/fixtures/cleanup';
import net from 'node:net';
import { createPostTestCleanups } from '../../../__tests__/fixtures/cleanup';

describe('sending and receiving across unix sockets works', async () => {
  let socketPath: string;
  let server: net.Server;

  const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
  beforeEach(async () => {
    socketPath = getUnixSocketPath();
    server = net.createServer();
    await onUdsServeReady(server, socketPath);

    return async () => {
      await postTestCleanup();
      server.close();
    };
  });

  test('basic send/receive', async () => {
    const clientTransport = new UnixDomainSocketClientTransport(
      socketPath,
      'client',
    );
    const serverTransport = new UnixDomainSocketServerTransport(
      server,
      'SERVER',
    );
    clientTransport.connect(serverTransport.clientId);
    const messages = [
      {
        msg: 'cool\nand\ngood',
        test: 123,
      },
      {
        msg: 'nice',
        test: [1, 2, 3, 4],
      },
    ];
    addPostTestCleanup(async () => {
      await cleanupTransports([clientTransport, serverTransport]);
    });

    for (const msg of messages) {
      const transportMessage = payloadToTransportMessage(msg);
      const msgId = clientTransport.send(
        serverTransport.clientId,
        transportMessage,
      );
      await expect(
        waitForMessage(serverTransport, (incoming) => incoming.id === msgId),
      ).resolves.toStrictEqual(transportMessage.payload);
    }

    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });

  test('hanging uds connection with no handshake is cleaned up after grace', async () => {
    const serverTransport = new UnixDomainSocketServerTransport(
      server,
      'SERVER',
    );
    addPostTestCleanup(async () => {
      await cleanupTransports([serverTransport]);
    });

    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const sock = new net.Socket();
      sock.on('connect', () => resolve(sock));
      sock.on('error', (err) => reject(err));
      sock.connect(socketPath);
    });

    expect(sock.readyState).toBe('open');

    // we never sent a handshake so there should be no connections or sessions
    expect(numberOfConnections(serverTransport)).toBe(0);
    expect(serverTransport.sessions.size).toBe(0);

    // advance time past the grace period
    await advanceFakeTimersBySessionGrace();

    // the connection should have been cleaned up
    expect(numberOfConnections(serverTransport)).toBe(0);
    expect(serverTransport.sessions.size).toBe(0);
    expect(sock.readyState).toBe('closed');

    await testFinishesCleanly({
      clientTransports: [],
      serverTransport,
    });
  });
});
