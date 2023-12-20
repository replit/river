import { describe, test, expect, afterEach, beforeEach } from 'vitest';
import { UnixDomainSocketClientTransport } from './client';
import { UnixDomainSocketServerTransport } from './server';
import {
  getUnixSocketPath,
  payloadToTransportMessage,
  waitForMessage,
} from '../../../util/testHelpers';
import fs from 'fs';
import { testFinishesCleanly } from '../../../__tests__/fixtures/cleanup';
import { BinaryCodec } from '../../../codec';
import { msg } from '../..';

describe('sending and receiving across unix sockets works', async () => {
  let socketPath: string;

  beforeEach(async () => {
    socketPath = getUnixSocketPath();
  });

  afterEach(async () => {
    if (fs.existsSync(socketPath)) {
      await fs.promises.unlink(socketPath);
    }
  });

  const getTransports = () => [
    new UnixDomainSocketClientTransport(socketPath, 'client', 'SERVER'),
    new UnixDomainSocketServerTransport(socketPath, 'SERVER'),
  ];

  test('basic send/receive', async () => {
    const [clientTransport, serverTransport] = getTransports();
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

  test('multiple connections + binary codec', async () => {
    const clientId1 = 'client1';
    const clientId2 = 'client2';
    const serverId = 'SERVER';
    const serverTransport = new UnixDomainSocketServerTransport(
      socketPath,
      serverId,
      { codec: BinaryCodec },
    );

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

    const initClient = async (id: string) => {
      const client = new UnixDomainSocketClientTransport(
        socketPath,
        id,
        serverId,
        { codec: BinaryCodec },
      );

      // client to server
      const initMsg = makeDummyMessage(id, serverId, 'hello server');
      const initMsgPromise = waitForMessage(
        serverTransport,
        (recv) => recv.id === initMsg.id,
      );
      client.send(initMsg);
      await expect(initMsgPromise).resolves.toStrictEqual(initMsg.payload);
      return client;
    };

    const client1Transport = await initClient(clientId1);
    const client2Transport = await initClient(clientId2);

    // sending messages from server to client shouldn't leak between clients
    const msg1 = makeDummyMessage(serverId, clientId1, 'hello client1');
    const msg2 = makeDummyMessage(serverId, clientId2, 'hello client2');
    const promises = Promise.all([
      // true means reject if we receive any message that isn't the one we are expecting
      waitForMessage(client2Transport, (recv) => recv.id === msg2.id, true),
      waitForMessage(client1Transport, (recv) => recv.id === msg1.id, true),
    ]);
    serverTransport.send(msg1);
    serverTransport.send(msg2);
    await expect(promises).resolves.toStrictEqual(
      expect.arrayContaining([msg1.payload, msg2.payload]),
    );

    await testFinishesCleanly({
      clientTransports: [client1Transport, client2Transport],
      serverTransport,
    });
  });
});
