import { describe, test, expect } from 'vitest';
import stream from 'node:stream';
import { StreamTransport } from './stream';
import { waitForMessage } from './util';

describe('sending and receiving across node streams works', () => {
  test('basic send/receive', async () => {
    const clientToServer = new stream.PassThrough();
    const serverToClient = new stream.PassThrough();
    const serverTransport = new StreamTransport(
      'SERVER',
      clientToServer,
      serverToClient,
    );
    const clientTransport = new StreamTransport(
      'client',
      serverToClient,
      clientToServer,
    );

    const msg = {
      msg: 'cool',
      test: 123,
    };

    const p = waitForMessage(serverTransport);
    clientTransport.send({
      id: '1',
      from: 'client',
      to: 'SERVER',
      serviceName: 'test',
      procedureName: 'test',
      payload: msg,
    });

    await expect(p).resolves.toStrictEqual(msg);
  });
});
