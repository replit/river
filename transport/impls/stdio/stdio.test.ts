import { describe, test, expect } from 'vitest';
import stream from 'node:stream';
import { StdioTransport } from './stdio';
import {
  payloadToTransportMessage,
  waitForMessage,
} from '../../../util/testHelpers';
import { ensureTransportIsClean } from '../../../__tests__/fixtures/cleanup';

describe('sending and receiving across node streams works', () => {
  test('basic send/receive', async () => {
    const clientToServer = new stream.PassThrough();
    const serverToClient = new stream.PassThrough();
    const serverTransport = new StdioTransport(
      'abc',
      clientToServer,
      serverToClient,
    );
    const clientTransport = new StdioTransport(
      'def',
      serverToClient,
      clientToServer,
    );

    const msg = {
      msg: 'cool',
      test: 123,
    };

    const p = waitForMessage(serverTransport);
    clientTransport.send(
      payloadToTransportMessage(
        msg,
        'stream',
        clientTransport.clientId,
        serverTransport.clientId,
      ),
    );

    await expect(p).resolves.toStrictEqual(msg);
    await clientTransport.close();
    await serverTransport.close();
    await ensureTransportIsClean(clientTransport);
    await ensureTransportIsClean(serverTransport);
  });
});
