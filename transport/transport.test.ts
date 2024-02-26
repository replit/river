import { describe, test, expect, afterAll, vi } from 'vitest';
import {
  createDummyTransportMessage,
  payloadToTransportMessage,
  waitForMessage,
} from '../util/testHelpers';
import { EventMap } from '../transport/events';
import {
  advanceFakeTimersByDisconnectGrace,
  testFinishesCleanly,
  waitFor,
} from '../__tests__/fixtures/cleanup';
import { testMatrix } from '../__tests__/fixtures/matrix';
import { PartialTransportMessage } from './message';

describe.each(testMatrix())(
  'transport-agnostic behaviour tests ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };
    const { getClientTransport, getServerTransport, cleanup } =
      await transport.setup(opts);
    afterAll(cleanup);

    test('connection is recreated after clean client disconnect', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const msg1 = createDummyTransportMessage();
      const msg2 = createDummyTransportMessage();

      const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      clientTransport.connections.forEach((conn) => conn.close());

      // by this point the client should have reconnected
      const msg2Id = clientTransport.send(serverTransport.clientId, msg2);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg2Id),
      ).resolves.toStrictEqual(msg2.payload);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('both client and server transport get connect/disconnect notifs', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const msg1 = createDummyTransportMessage();
      const msg2 = createDummyTransportMessage();

      const clientConnConnect = vi.fn();
      const clientConnDisconnect = vi.fn();
      const clientConnHandler = (evt: EventMap['connectionStatus']) => {
        if (evt.status === 'connect') return clientConnConnect();
        if (evt.status === 'disconnect') return clientConnDisconnect();
      };

      const clientSessConnect = vi.fn();
      const clientSessDisconnect = vi.fn();
      const clientSessHandler = (evt: EventMap['sessionStatus']) => {
        if (evt.status === 'connect') return clientSessConnect();
        if (evt.status === 'disconnect') return clientSessDisconnect();
      };

      const serverConnConnect = vi.fn();
      const serverConnDisconnect = vi.fn();
      const serverConnHandler = (evt: EventMap['connectionStatus']) => {
        if (evt.status === 'connect') return serverConnConnect();
        if (evt.status === 'disconnect') return serverConnDisconnect();
      };

      const serverSessConnect = vi.fn();
      const serverSessDisconnect = vi.fn();
      const serverSessHandler = (evt: EventMap['sessionStatus']) => {
        if (evt.status === 'connect') return serverSessConnect();
        if (evt.status === 'disconnect') return serverSessDisconnect();
      };

      clientTransport.addEventListener('connectionStatus', clientConnHandler);
      clientTransport.addEventListener('sessionStatus', clientSessHandler);
      serverTransport.addEventListener('connectionStatus', serverConnHandler);
      serverTransport.addEventListener('sessionStatus', serverSessHandler);

      // | = current
      // - = connection
      // > = start
      // c = connect
      // x = disconnect
      // session    >  | (connecting)
      // connection >  | (connecting)
      expect(clientConnConnect).toHaveBeenCalledTimes(0);
      expect(serverConnConnect).toHaveBeenCalledTimes(0);
      expect(clientConnDisconnect).toHaveBeenCalledTimes(0);
      expect(serverConnDisconnect).toHaveBeenCalledTimes(0);

      expect(clientSessConnect).toHaveBeenCalledTimes(0);
      expect(serverSessConnect).toHaveBeenCalledTimes(0);
      expect(clientSessDisconnect).toHaveBeenCalledTimes(0);
      expect(serverSessDisconnect).toHaveBeenCalledTimes(0);

      const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      // session    >  c--| (connected)
      // connection >  c--| (connected)
      expect(clientConnConnect).toHaveBeenCalledTimes(1);
      expect(serverConnConnect).toHaveBeenCalledTimes(1);
      expect(clientConnDisconnect).toHaveBeenCalledTimes(0);
      expect(serverConnDisconnect).toHaveBeenCalledTimes(0);

      expect(clientSessConnect).toHaveBeenCalledTimes(1);
      expect(serverSessConnect).toHaveBeenCalledTimes(1);
      expect(clientSessDisconnect).toHaveBeenCalledTimes(0);
      expect(serverSessDisconnect).toHaveBeenCalledTimes(0);

      // clean disconnect + reconnect within grace period
      clientTransport.connections.forEach((conn) => conn.close());

      // wait for connection status to propagate to server
      // session    >  c------| (connected)
      // connection >  c--x   | (disconnected)
      await waitFor(() => expect(clientConnConnect).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverConnConnect).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(clientConnDisconnect).toHaveBeenCalledTimes(1),
      );
      await waitFor(() =>
        expect(serverConnDisconnect).toHaveBeenCalledTimes(1),
      );

      await waitFor(() => expect(clientSessConnect).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessConnect).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(clientSessDisconnect).toHaveBeenCalledTimes(0),
      );
      await waitFor(() =>
        expect(serverSessDisconnect).toHaveBeenCalledTimes(0),
      );

      // by this point the client should have reconnected
      // session    >  c----------| (connected)
      // connection >  c--x   c---| (connected)
      const msg2Id = clientTransport.send(serverTransport.clientId, msg2);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg2Id),
      ).resolves.toStrictEqual(msg2.payload);
      expect(clientConnConnect).toHaveBeenCalledTimes(2);
      expect(serverConnConnect).toHaveBeenCalledTimes(2);
      expect(clientConnDisconnect).toHaveBeenCalledTimes(1);
      expect(serverConnDisconnect).toHaveBeenCalledTimes(1);

      expect(clientSessConnect).toHaveBeenCalledTimes(1);
      expect(clientSessDisconnect).toHaveBeenCalledTimes(0);
      expect(serverSessConnect).toHaveBeenCalledTimes(1);
      expect(serverSessDisconnect).toHaveBeenCalledTimes(0);

      // disconnect session entirely
      // session    >  c------------x  | (disconnected)
      // connection >  c--x   c-----x  | (disconnected)
      vi.useFakeTimers({ shouldAdvanceTime: true });
      clientTransport.tryReconnecting = false;
      clientTransport.connections.forEach((conn) => conn.close());
      await waitFor(() => expect(clientConnConnect).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(serverConnConnect).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(clientConnDisconnect).toHaveBeenCalledTimes(2),
      );
      await waitFor(() =>
        expect(serverConnDisconnect).toHaveBeenCalledTimes(2),
      );

      await advanceFakeTimersByDisconnectGrace();
      await waitFor(() => expect(clientSessConnect).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessConnect).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(clientSessDisconnect).toHaveBeenCalledTimes(1),
      );
      await waitFor(() =>
        expect(serverSessDisconnect).toHaveBeenCalledTimes(1),
      );

      // teardown
      clientTransport.removeEventListener(
        'connectionStatus',
        clientConnHandler,
      );
      serverTransport.removeEventListener(
        'connectionStatus',
        serverConnHandler,
      );
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('transport connection is not recreated after destroy', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const msg1 = createDummyTransportMessage();
      const msg2 = createDummyTransportMessage();

      const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      await clientTransport.destroy();
      expect(() =>
        clientTransport.send(serverTransport.clientId, msg2),
      ).toThrow(new Error('transport is destroyed, cant send'));

      // this is not expected to be clean because we destroyed the transport
      expect(clientTransport.state).toEqual('destroyed');
      await waitFor(() =>
        expect(
          clientTransport.connections,
          `transport ${clientTransport.clientId} should not have open connections after the test`,
        ).toStrictEqual(new Map()),
      );

      await clientTransport.close();
      await serverTransport.close();
    });

    test('multiple connections works', async () => {
      const clientId1 = 'client1';
      const clientId2 = 'client2';
      const serverId = 'SERVER';
      const serverTransport = getServerTransport();

      const makeDummyMessage = (message: string): PartialTransportMessage => {
        return payloadToTransportMessage({ message });
      };

      const initClient = async (id: string) => {
        const client = getClientTransport(id);

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
  },
);
