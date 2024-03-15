import { describe, test, expect, afterAll, onTestFinished } from 'vitest';
import { UnixDomainSocketClientTransport } from './client';
import { UnixDomainSocketServerTransport } from './server';
import {
  getUnixSocketPath,
  onUdsServeReady,
  payloadToTransportMessage,
  waitForMessage,
} from '../../../util/testHelpers';
import { testFinishesCleanly } from '../../../__tests__/fixtures/cleanup';
import net from 'node:net';

describe('sending and receiving across unix sockets works', async () => {
  const socketPath = getUnixSocketPath();
  const server = net.createServer();
  await onUdsServeReady(server, socketPath);

  afterAll(() => {
    server.close();
  });

  const getTransports = () =>
    [
      new UnixDomainSocketClientTransport(socketPath, 'client'),
      new UnixDomainSocketServerTransport(server, 'SERVER'),
    ] as const;

  test('basic send/receive', async () => {
    const [clientTransport, serverTransport] = getTransports();
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
});
