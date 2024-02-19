import { describe, test, expect } from 'vitest';
import stream from 'node:stream';
import { StdioClientTransport } from './client';
import {
  payloadToTransportMessage,
  waitForMessage,
} from '../../../util/testHelpers';
import { testFinishesCleanly } from '../../../__tests__/fixtures/cleanup';
import { StdioServerTransport } from './server';

describe('sending and receiving across node streams works', () => {
  test('basic send/receive', async () => {
    const clientToServer = new stream.PassThrough();
    const serverToClient = new stream.PassThrough();
    const serverTransport = new StdioServerTransport(
      'abc',
      clientToServer,
      serverToClient,
    );
    const clientTransport = new StdioClientTransport(
      'def',
      serverToClient,
      clientToServer,
      serverTransport.clientId,
    );

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

    for (const msg of messages) {
      const transportMessage = payloadToTransportMessage(
        msg,
        'stream',
        clientTransport.clientId,
        serverTransport.clientId,
      );

      const p = waitForMessage(
        serverTransport,
        (incoming) => incoming.id === transportMessage.id,
      );
      clientTransport.send(transportMessage);
      await expect(p).resolves.toStrictEqual(transportMessage.payload);
    }

    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });
});
