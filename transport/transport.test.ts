import { describe, test, expect, afterAll, vi, onTestFinished } from 'vitest';
import {
  createDummyTransportMessage,
  payloadToTransportMessage,
  waitForMessage,
  testingSessionOptions,
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
  'transport connection behaviour tests ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };
    const { getClientTransport, getServerTransport, cleanup } =
      await transport.setup(opts);
    afterAll(cleanup);

    test('connection is recreated after clean client disconnect', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
        });
      });

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
    });

    test('idle transport cleans up nicely', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      await waitFor(() => expect(serverTransport.connections.size).toBe(1));
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
        });
      });
    });

    test('heartbeats should not interupt normal operation', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
        });
      });

      vi.useFakeTimers();
      await clientTransport.connect(serverTransport.clientId);
      for (let i = 0; i < 5; i++) {
        const msg = createDummyTransportMessage();
        const msg1Id = clientTransport.send(serverTransport.clientId, msg);
        await expect(
          waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
        ).resolves.toStrictEqual(msg.payload);

        // wait for heartbeat interval to elapse
        await vi.runOnlyPendingTimersAsync();
        await vi.advanceTimersByTimeAsync(
          testingSessionOptions.heartbeatIntervalMs * (1 + Math.random()),
        );
      }
    });

    test('seq numbers should be persisted across transparent reconnects', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
        });
      });

      await waitFor(() => expect(clientTransport.connections.size).toEqual(1));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(1));

      /// create a hundred messages
      const clientMsgs = Array.from({ length: 100 }, () =>
        createDummyTransportMessage(),
      );

      // send the first 90 (with a disconnect at 55)
      const first90 = clientMsgs.slice(0, 90);
      const first90Ids = [];
      const first90Promises = [];

      for (let i = 0; i < 55; i++) {
        const msg = first90[i];
        const id = clientTransport.send(serverTransport.clientId, msg);
        first90Ids.push(id);
        first90Promises.push(
          waitForMessage(serverTransport, (recv) => recv.id === id),
        );
      }
      // wait for the server to receive at least the first 30
      await expect(
        Promise.all(first90Promises.slice(0, 30)),
      ).resolves.toStrictEqual(first90.slice(0, 30).map((msg) => msg.payload));

      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.connections.forEach((conn) => conn.close());
      await waitFor(() => expect(clientTransport.connections.size).toEqual(0));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(0));

      for (let i = 55; i < 90; i++) {
        const msg = first90[i];
        const id = clientTransport.send(serverTransport.clientId, msg);
        first90Ids.push(id);
        first90Promises.push(
          waitForMessage(serverTransport, (recv) => recv.id === id),
        );
      }

      // send the last 10
      const last10 = clientMsgs.slice(90);
      const last10Ids = last10.map((msg) =>
        clientTransport.send(serverTransport.clientId, msg),
      );

      // wait for the server to receive everything
      const last10Promises = last10Ids.map((id) =>
        waitForMessage(serverTransport, (recv) => recv.id === id),
      );

      clientTransport.reconnectOnConnectionDrop = true;
      await clientTransport.connect('SERVER');
      await waitFor(() => expect(clientTransport.connections.size).toEqual(1));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(1));

      await expect(
        Promise.all([...first90Promises, ...last10Promises]),
      ).resolves.toStrictEqual(clientMsgs.map((msg) => msg.payload));
    });

    test('both client and server transport get connect/disconnect notifs', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const clientConnStart = vi.fn();
      const clientConnStop = vi.fn();
      const clientConnHandler = (evt: EventMap['connectionStatus']) => {
        switch (evt.status) {
          case 'connect':
            clientConnStart();
            break;
          case 'disconnect':
            clientConnStop();
            break;
        }
      };

      const clientSessStart = vi.fn();
      const clientSessStop = vi.fn();
      const clientSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'connect':
            clientSessStart();
            break;
          case 'disconnect':
            clientSessStop();
            break;
        }
      };

      const serverConnStart = vi.fn();
      const serverConnStop = vi.fn();
      const serverConnHandler = (evt: EventMap['connectionStatus']) => {
        switch (evt.status) {
          case 'connect':
            serverConnStart();
            break;
          case 'disconnect':
            serverConnStop();
            break;
        }
      };

      const serverSessStart = vi.fn();
      const serverSessStop = vi.fn();
      const serverSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'connect':
            serverSessStart();
            break;
          case 'disconnect':
            serverSessStop();
            break;
        }
      };

      onTestFinished(async () => {
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

      clientTransport.addEventListener('connectionStatus', clientConnHandler);
      clientTransport.addEventListener('sessionStatus', clientSessHandler);
      serverTransport.addEventListener('connectionStatus', serverConnHandler);
      serverTransport.addEventListener('sessionStatus', serverSessHandler);

      const msg1 = createDummyTransportMessage();
      const msg2 = createDummyTransportMessage();

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
      clientTransport.reconnectOnConnectionDrop = false;
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
    });

    test('transport connection is not recreated after destroy', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const msg1 = createDummyTransportMessage();

      const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      clientTransport.destroy();

      // this is not expected to be clean because we destroyed the transport
      expect(clientTransport.state).toEqual('destroyed');
      await waitFor(() =>
        expect(
          clientTransport.connections,
          `transport ${clientTransport.clientId} should not have open connections after the test`,
        ).toStrictEqual(new Map()),
      );

      clientTransport.close();
      serverTransport.close();
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
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [client1Transport, client2Transport],
          serverTransport,
        });
      });

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
    });
  },
);

describe.each(testMatrix())(
  'transport connection edge cases ($transport.name transport, $codec.name codec)',
  ({ transport, codec }) => {
    test('messages should not be resent when the client loses all state and reconnects to the server', async () => {
      const opts = { codec: codec.codec };
      const { getClientTransport, getServerTransport, cleanup } =
        await transport.setup(opts);
      onTestFinished(cleanup);

      let clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const serverConnStart = vi.fn();
      const serverConnStop = vi.fn();
      const serverConnHandler = (evt: EventMap['connectionStatus']) => {
        switch (evt.status) {
          case 'connect':
            serverConnStart();
            break;
          case 'disconnect':
            serverConnStop();
            break;
        }
      };

      const serverSessStart = vi.fn();
      const serverSessStop = vi.fn();
      const serverSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'connect':
            serverSessStart();
            break;
          case 'disconnect':
            serverSessStop();
            break;
        }
      };

      serverTransport.addEventListener('connectionStatus', serverConnHandler);
      serverTransport.addEventListener('sessionStatus', serverSessHandler);
      onTestFinished(async () => {
        // teardown
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

      const msg1 = createDummyTransportMessage();
      const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      await waitFor(() => expect(serverConnStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverConnStop).toHaveBeenCalledTimes(0));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(0));

      // kill the client
      clientTransport.close();
      serverTransport.connections.forEach((conn) => conn.close());

      // queue up some messages
      serverTransport.send(
        clientTransport.clientId,
        createDummyTransportMessage(),
      );
      serverTransport.send(
        clientTransport.clientId,
        createDummyTransportMessage(),
      );

      // create a new client transport
      // and wait for it to connect
      clientTransport = getClientTransport('client');
      await waitFor(() => expect(serverConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(serverConnStop).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(1));

      // when we reconnect, send another message
      const msg4 = createDummyTransportMessage();
      const msg4Id = serverTransport.send(clientTransport.clientId, msg4);
      await expect(
        // ensure that when the server gets it, it's not msg2 or msg3
        // true indicates to reject any other messages
        waitForMessage(clientTransport, (recv) => recv.id === msg4Id, true),
      ).resolves.toStrictEqual(msg4.payload);
    });

    test('messages should not be resent when client reconnects to a different instance of the server', async () => {
      const opts = { codec: codec.codec };
      const { getClientTransport, getServerTransport, restartServer, cleanup } =
        await transport.setup(opts);
      onTestFinished(cleanup);

      const clientTransport = getClientTransport('client');
      let serverTransport = getServerTransport();
      const clientConnStart = vi.fn();
      const clientConnStop = vi.fn();
      const clientConnHandler = (evt: EventMap['connectionStatus']) => {
        switch (evt.status) {
          case 'connect':
            clientConnStart();
            break;
          case 'disconnect':
            clientConnStop();
            break;
        }
      };

      const clientSessStart = vi.fn();
      const clientSessStop = vi.fn();
      const clientSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'connect':
            clientSessStart();
            break;
          case 'disconnect':
            clientSessStop();
            break;
        }
      };

      clientTransport.addEventListener('connectionStatus', clientConnHandler);
      clientTransport.addEventListener('sessionStatus', clientSessHandler);
      onTestFinished(async () => {
        // teardown
        clientTransport.removeEventListener(
          'connectionStatus',
          clientConnHandler,
        );
        clientTransport.removeEventListener('sessionStatus', clientSessHandler);
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
        });
      });

      const msg1 = createDummyTransportMessage();
      const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      expect(clientConnStart).toHaveBeenCalledTimes(1);
      expect(clientSessStart).toHaveBeenCalledTimes(1);
      expect(clientConnStop).toHaveBeenCalledTimes(0);
      expect(clientSessStop).toHaveBeenCalledTimes(0);

      // bring client side connections down and stop trying to reconnect
      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.connections.forEach((conn) => conn.close());

      // buffer some messages
      clientTransport.send(
        serverTransport.clientId,
        createDummyTransportMessage(),
      );
      clientTransport.send(
        serverTransport.clientId,
        createDummyTransportMessage(),
      );

      await waitFor(() => expect(clientConnStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientConnStop).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(0));

      // kill old server and make a new transport with the new server
      await restartServer();
      serverTransport = getServerTransport();
      expect(serverTransport.sessions.size).toBe(0);

      // eagerly reconnect client
      clientTransport.reconnectOnConnectionDrop = true;
      await clientTransport.connect('SERVER');

      await waitFor(() => expect(clientConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(clientConnStop).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(1));

      // when we reconnect, send another message
      const msg4 = createDummyTransportMessage();
      const msg4Id = clientTransport.send(serverTransport.clientId, msg4);
      await expect(
        // ensure that when the server gets it, it's not msg2 or msg3
        // true indicates to reject any other messages
        waitForMessage(serverTransport, (recv) => recv.id === msg4Id, true),
      ).resolves.toStrictEqual(msg4.payload);
    });

    test('recovers from phantom disconnects', async () => {
      const opts = { codec: codec.codec };
      const {
        getClientTransport,
        getServerTransport,
        simulatePhantomDisconnect,
        cleanup,
      } = await transport.setup(opts);
      onTestFinished(cleanup);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const clientConnStart = vi.fn();
      const clientConnStop = vi.fn();
      const clientConnHandler = (evt: EventMap['connectionStatus']) => {
        switch (evt.status) {
          case 'connect':
            clientConnStart();
            break;
          case 'disconnect':
            clientConnStop();
            break;
        }
      };

      const clientSessStart = vi.fn();
      const clientSessStop = vi.fn();
      const clientSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'connect':
            clientSessStart();
            break;
          case 'disconnect':
            clientSessStop();
            break;
        }
      };

      const serverConnStart = vi.fn();
      const serverConnStop = vi.fn();
      const serverConnHandler = (evt: EventMap['connectionStatus']) => {
        switch (evt.status) {
          case 'connect':
            serverConnStart();
            break;
          case 'disconnect':
            serverConnStop();
            break;
        }
      };

      const serverSessStart = vi.fn();
      const serverSessStop = vi.fn();
      const serverSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'connect':
            serverSessStart();
            break;
          case 'disconnect':
            serverSessStop();
            break;
        }
      };

      clientTransport.addEventListener('connectionStatus', clientConnHandler);
      clientTransport.addEventListener('sessionStatus', clientSessHandler);
      serverTransport.addEventListener('connectionStatus', serverConnHandler);
      serverTransport.addEventListener('sessionStatus', serverSessHandler);
      onTestFinished(async () => {
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

      const msg1 = createDummyTransportMessage();

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
      for (let i = 0; i < testingSessionOptions.heartbeatsUntilDead; i++) {
        await vi.advanceTimersByTimeAsync(
          testingSessionOptions.heartbeatIntervalMs + 1,
        );
      }

      await waitFor(() => expect(clientConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(serverConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(clientConnStop).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverConnStop).toHaveBeenCalledTimes(1));

      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(0));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(0));
    });
  },
);
