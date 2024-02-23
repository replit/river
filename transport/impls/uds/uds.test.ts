import { describe, test, expect, afterAll } from 'vitest';
import { UnixDomainSocketClientTransport } from './client';
import { UnixDomainSocketServerTransport } from './server';
import {
  getUnixSocketPath,
  onUdsServeReady,
  payloadToTransportMessage,
  waitForMessage,
} from '../../../util/testHelpers';
import { testFinishesCleanly } from '../../../__tests__/fixtures/cleanup';
import { BinaryCodec } from '../../../codec';
import net from 'node:net';
import { PartialTransportMessage } from '../../message';

describe('sending and receiving across unix sockets works', async () => {
  const socketPath = getUnixSocketPath();
  const server = net.createServer();
  await onUdsServeReady(server, socketPath);

  afterAll(async () => {
    server.close();
  });

  const getTransports = () => [
    new UnixDomainSocketClientTransport(socketPath, 'client', 'SERVER'),
    new UnixDomainSocketServerTransport(server, 'SERVER'),
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

  test('multiple connections + binary codec', async () => {
    const clientId1 = 'client1';
    const clientId2 = 'client2';
    const serverId = 'SERVER';
    const serverTransport = new UnixDomainSocketServerTransport(
      server,
      serverId,
      { codec: BinaryCodec },
    );

    const makeDummyMessage = (message: string): PartialTransportMessage => {
      return payloadToTransportMessage({ message });
    };

    const initClient = async (id: string) => {
      const client = new UnixDomainSocketClientTransport(
        socketPath,
        id,
        serverId,
        { codec: BinaryCodec },
      );

      // client to server
      const initMsg = makeDummyMessage('hello\nserver');
      const initMsgId = client.send(serverId, initMsg);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === initMsgId),
      ).resolves.toStrictEqual(initMsg.payload);
      return client;
    };

    const client1Transport = await initClient(clientId1);
    const client2Transport = await initClient(clientId2);

    // sending messages from server to client shouldn't leak between clients
    const msg1 = makeDummyMessage('hello\nclient1');
    const msg2 = makeDummyMessage('hello\nclient2');
    const msg1Id = serverTransport.send(clientId1, msg1);
    const msg2Id = serverTransport.send(clientId2, msg2);

    const promises = Promise.all([
      // true means reject if we receive any message that isn't the one we are expecting
      waitForMessage(client2Transport, (recv) => recv.id === msg2Id, true),
      waitForMessage(client1Transport, (recv) => recv.id === msg1Id, true),
    ]);
    await expect(promises).resolves.toStrictEqual(
      expect.arrayContaining([msg1.payload, msg2.payload]),
    );

    await testFinishesCleanly({
      clientTransports: [client1Transport, client2Transport],
      serverTransport,
    });
  });
});
