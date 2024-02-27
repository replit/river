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
import { HEARTBEATS_TILL_DEAD, HEARTBEAT_INTERVAL_MS } from './session';

describe.each(testMatrix())(
  'transport behaviour tests ($transport.name transport, $codec.name codec)',
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

      const clientConnStart = vi.fn();
      const clientConnStop = vi.fn();
      const clientConnHandler = (evt: EventMap['connectionStatus']) => {
        if (evt.status === 'connect') return clientConnStart();
        if (evt.status === 'disconnect') return clientConnStop();
      };

      const clientSessStart = vi.fn();
      const clientSessStop = vi.fn();
      const clientSessHandler = (evt: EventMap['sessionStatus']) => {
        if (evt.status === 'connect') return clientSessStart();
        if (evt.status === 'disconnect') return clientSessStop();
      };

      const serverConnStart = vi.fn();
      const serverConnStop = vi.fn();
      const serverConnHandler = (evt: EventMap['connectionStatus']) => {
        if (evt.status === 'connect') return serverConnStart();
        if (evt.status === 'disconnect') return serverConnStop();
      };

      const serverSessStart = vi.fn();
      const serverSessStop = vi.fn();
      const serverSessHandler = (evt: EventMap['sessionStatus']) => {
        if (evt.status === 'connect') return serverSessStart();
        if (evt.status === 'disconnect') return serverSessStop();
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
      expect(clientConnStart).toHaveBeenCalledTimes(0);
      expect(serverConnStart).toHaveBeenCalledTimes(0);
      expect(clientConnStop).toHaveBeenCalledTimes(0);
      expect(serverConnStop).toHaveBeenCalledTimes(0);

      expect(clientSessStart).toHaveBeenCalledTimes(0);
      expect(serverSessStart).toHaveBeenCalledTimes(0);
      expect(clientSessStop).toHaveBeenCalledTimes(0);
      expect(serverSessStop).toHaveBeenCalledTimes(0);

      const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      // session    >  c--| (connected)
      // connection >  c--| (connected)
      expect(clientConnStart).toHaveBeenCalledTimes(1);
      expect(serverConnStart).toHaveBeenCalledTimes(1);
      expect(clientConnStop).toHaveBeenCalledTimes(0);
      expect(serverConnStop).toHaveBeenCalledTimes(0);

      expect(clientSessStart).toHaveBeenCalledTimes(1);
      expect(serverSessStart).toHaveBeenCalledTimes(1);
      expect(clientSessStop).toHaveBeenCalledTimes(0);
      expect(serverSessStop).toHaveBeenCalledTimes(0);

      // clean disconnect + reconnect within grace period
      clientTransport.connections.forEach((conn) => conn.close());

      // wait for connection status to propagate to server
      // session    >  c------| (connected)
      // connection >  c--x   | (disconnected)
      await waitFor(() => expect(clientConnStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverConnStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientConnStop).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverConnStop).toHaveBeenCalledTimes(1));

      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(0));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(0));

      // by this point the client should have reconnected
      // session    >  c----------| (connected)
      // connection >  c--x   c---| (connected)
      const msg2Id = clientTransport.send(serverTransport.clientId, msg2);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg2Id),
      ).resolves.toStrictEqual(msg2.payload);
      expect(clientConnStart).toHaveBeenCalledTimes(2);
      expect(serverConnStart).toHaveBeenCalledTimes(2);
      expect(clientConnStop).toHaveBeenCalledTimes(1);
      expect(serverConnStop).toHaveBeenCalledTimes(1);

      expect(clientSessStart).toHaveBeenCalledTimes(1);
      expect(clientSessStop).toHaveBeenCalledTimes(0);
      expect(serverSessStart).toHaveBeenCalledTimes(1);
      expect(serverSessStop).toHaveBeenCalledTimes(0);

      // disconnect session entirely
      // session    >  c------------x  | (disconnected)
      // connection >  c--x   c-----x  | (disconnected)
      vi.useFakeTimers({ shouldAdvanceTime: true });
      clientTransport.tryReconnecting = false;
      clientTransport.connections.forEach((conn) => conn.close());
      await waitFor(() => expect(clientConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(serverConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(clientConnStop).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(serverConnStop).toHaveBeenCalledTimes(2));

      await advanceFakeTimersByDisconnectGrace();
      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(1));

      // teardown
      clientTransport.removeEventListener(
        'connectionStatus',
        clientConnHandler,
      );
      clientTransport.removeEventListener('sessionStatus', clientSessHandler);
      serverTransport.removeEventListener(
        'connectionStatus',
        serverConnHandler,
      );
      serverTransport.removeEventListener('sessionStatus', serverSessHandler);
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

describe.each(testMatrix())(
  'transport-agnostic behaviour tests ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    test('recovers from phantom disconnects', async () => {
      const opts = { codec: codec.codec };
      const {
        getClientTransport,
        getServerTransport,
        simulatePhantomDisconnect,
        cleanup,
      } = await transport.setup(opts);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const msg1 = createDummyTransportMessage();

      const clientConnStart = vi.fn();
      const clientConnStop = vi.fn();
      const clientConnHandler = (evt: EventMap['connectionStatus']) => {
        if (evt.status === 'connect') return clientConnStart();
        if (evt.status === 'disconnect') return clientConnStop();
      };

      const clientSessStart = vi.fn();
      const clientSessStop = vi.fn();
      const clientSessHandler = (evt: EventMap['sessionStatus']) => {
        if (evt.status === 'connect') return clientSessStart();
        if (evt.status === 'disconnect') return clientSessStop();
      };

      const serverConnStart = vi.fn();
      const serverConnStop = vi.fn();
      const serverConnHandler = (evt: EventMap['connectionStatus']) => {
        if (evt.status === 'connect') return serverConnStart();
        if (evt.status === 'disconnect') return serverConnStop();
      };

      const serverSessStart = vi.fn();
      const serverSessStop = vi.fn();
      const serverSessHandler = (evt: EventMap['sessionStatus']) => {
        if (evt.status === 'connect') return serverSessStart();
        if (evt.status === 'disconnect') return serverSessStop();
      };

      clientTransport.addEventListener('connectionStatus', clientConnHandler);
      clientTransport.addEventListener('sessionStatus', clientSessHandler);
      serverTransport.addEventListener('connectionStatus', serverConnHandler);
      serverTransport.addEventListener('sessionStatus', serverSessHandler);

      const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      expect(clientConnStart).toHaveBeenCalledTimes(1);
      expect(serverConnStart).toHaveBeenCalledTimes(1);
      expect(clientConnStop).toHaveBeenCalledTimes(0);
      expect(serverConnStop).toHaveBeenCalledTimes(0);
      expect(clientSessStart).toHaveBeenCalledTimes(1);
      expect(serverSessStart).toHaveBeenCalledTimes(1);
      expect(clientSessStop).toHaveBeenCalledTimes(0);
      expect(serverSessStop).toHaveBeenCalledTimes(0);

      // now, let's wait until the connection is considered dead
      simulatePhantomDisconnect();
      await vi.runOnlyPendingTimersAsync();
      for (let i = 0; i < HEARTBEATS_TILL_DEAD; i++) {
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 1);
      }

      await waitFor(() => expect(clientConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(serverConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(clientConnStop).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverConnStop).toHaveBeenCalledTimes(1));

      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(0));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(0));

      // teardown
      clientTransport.removeEventListener(
        'connectionStatus',
        clientConnHandler,
      );
      clientTransport.removeEventListener('sessionStatus', clientSessHandler);
      serverTransport.removeEventListener(
        'connectionStatus',
        serverConnHandler,
      );
      serverTransport.removeEventListener('sessionStatus', serverSessHandler);
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      }).finally(() => {
        cleanup();
      });
    });
  },
);
