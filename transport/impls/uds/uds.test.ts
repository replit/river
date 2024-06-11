import { describe, test, expect, vi, beforeEach } from 'vitest';
import { UnixDomainSocketClientTransport } from './client';
import { UnixDomainSocketServerTransport } from './server';
import {
  getUnixSocketPath,
  onUdsServeReady,
  payloadToTransportMessage,
  waitForMessage,
} from '../../../util/testHelpers';
import {
  advanceFakeTimersBySessionGrace,
  testFinishesCleanly,
} from '../../../__tests__/fixtures/cleanup';
import net from 'node:net';
import { createPostTestChecks } from '../../../__tests__/cleanup.test';

describe('sending and receiving across unix sockets works', async () => {
  let socketPath: string;
  let server: net.Server;

  const { onTestFinished, postTestChecks } = createPostTestChecks();
  beforeEach(async () => {
    socketPath = getUnixSocketPath();
    server = net.createServer();
    await onUdsServeReady(server, socketPath);

    return async () => {
      await postTestChecks();
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
    await clientTransport.connect(serverTransport.clientId);
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
    onTestFinished(async () => {
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
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
  });

  test('hanging uds connection with no handshake is cleaned up after grace', async () => {
    const serverTransport = new UnixDomainSocketServerTransport(
      server,
      'SERVER',
    );
    onTestFinished(async () => {
      await testFinishesCleanly({
        clientTransports: [],
        serverTransport,
      });
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const sock = new net.Socket();
      sock.on('connect', () => resolve(sock));
      sock.on('error', (err) => reject(err));
      sock.connect(socketPath);
    });

    expect(sock.readyState).toBe('open');

    // we never sent a handshake so there should be no connections or sessions
    expect(serverTransport.connections.size).toBe(0);
    expect(serverTransport.sessions.size).toBe(0);

    // advance time past the grace period
    await advanceFakeTimersBySessionGrace();

    // the connection should have been cleaned up
    expect(serverTransport.connections.size).toBe(0);
    expect(serverTransport.sessions.size).toBe(0);
    expect(sock.readyState).toBe('closed');
  });
});
