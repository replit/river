import { describe, test, expect, vi, assert, beforeEach } from 'vitest';
import {
  createDummyTransportMessage,
  payloadToTransportMessage,
  waitForMessage,
  testingSessionOptions,
} from '../util/testHelpers';
import { EventMap, ProtocolError } from '../transport/events';
import {
  advanceFakeTimersBySessionGrace,
  testFinishesCleanly,
  waitFor,
} from '../__tests__/fixtures/cleanup';
import { testMatrix } from '../__tests__/fixtures/matrix';
import { PartialTransportMessage } from './message';
import { Type } from '@sinclair/typebox';
import { TestSetupHelpers } from '../__tests__/fixtures/transports';
import { createPostTestChecks } from '../__tests__/fixtures/cleanup';

describe.each(testMatrix())(
  'transport connection behaviour tests ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };

    const { onTestFinished, postTestChecks } = createPostTestChecks();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;
      return async () => {
        await postTestChecks();
        await setup.cleanup();
      };
    });

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

    test('sending right after session event should not cause invalid handshake', async () => {
      const clientTransport = getClientTransport('client');
      const protocolError = vi.fn();
      clientTransport.addEventListener('protocolError', protocolError);
      const serverTransport = getServerTransport();

      const msg = createDummyTransportMessage();
      const msgPromise = waitForMessage(serverTransport);
      const sendHandle = (evt: EventMap['sessionStatus']) => {
        if (evt.status === 'connect') {
          clientTransport.send(serverTransport.clientId, msg);
        }
      };

      clientTransport.addEventListener('sessionStatus', sendHandle);
      onTestFinished(async () => {
        clientTransport.removeEventListener('protocolError', protocolError);
        clientTransport.removeEventListener('sessionStatus', sendHandle);
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
        });
      });

      await expect(msgPromise).resolves.toStrictEqual(msg.payload);
      expect(protocolError).toHaveBeenCalledTimes(0);
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

      await advanceFakeTimersBySessionGrace();
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

      clientTransport.close();

      // this is not expected to be clean because we closed the transport
      expect(clientTransport.getStatus()).toEqual('closed');
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
    const opts = { codec: codec.codec };
    let testHelpers: TestSetupHelpers;
    const { onTestFinished, postTestChecks } = createPostTestChecks();
    beforeEach(async () => {
      testHelpers = await transport.setup({ client: opts, server: opts });
      return async () => {
        await postTestChecks();
        await testHelpers.cleanup();
      };
    });

    test('messages should not be resent when the client loses all state and reconnects to the server', async () => {
      let clientTransport = testHelpers.getClientTransport('client');
      const serverTransport = testHelpers.getServerTransport();
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
      clientTransport = testHelpers.getClientTransport('client');
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
      const clientTransport = testHelpers.getClientTransport('client');
      let serverTransport = testHelpers.getServerTransport();
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
      await testHelpers.restartServer();
      serverTransport = testHelpers.getServerTransport();
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
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const clientTransport = testHelpers.getClientTransport('client');
      const serverTransport = testHelpers.getServerTransport();
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
      testHelpers.simulatePhantomDisconnect();
      await vi.runOnlyPendingTimersAsync();
      for (let i = 0; i < testingSessionOptions.heartbeatsUntilDead + 1; i++) {
        await vi.advanceTimersByTimeAsync(
          testingSessionOptions.heartbeatIntervalMs,
        );
      }

      // should have reconnected by now
      await waitFor(() => expect(clientConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(serverConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(clientConnStop).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverConnStop).toHaveBeenCalledTimes(1));

      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(0));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(0));

      // ensure sending across the connection still works
      const msg2 = createDummyTransportMessage();
      const msg2Id = clientTransport.send(serverTransport.clientId, msg2);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg2Id),
      ).resolves.toStrictEqual(msg2.payload);
    });
  },
);

describe.each(testMatrix())(
  'transport handshake tests ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };

    const { onTestFinished, postTestChecks } = createPostTestChecks();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;
      return async () => {
        await postTestChecks();
        await setup.cleanup();
      };
    });

    test('handshakes and stores parsed metadata in session', async () => {
      const schema = Type.Object({
        kept: Type.String(),
        discarded: Type.String(),
      });
      const get = vi.fn(async () => ({ kept: 'kept', discarded: 'discarded' }));
      const parse = vi.fn(async (metadata: unknown) => ({
        // @ts-expect-error - we haven't extended the global type here
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        kept: metadata.kept,
      }));

      const serverTransport = getServerTransport({
        schema,
        validate: parse,
      });
      const clientTransport = getClientTransport('client', {
        schema,
        construct: get,
      });
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
        });
      });

      await waitFor(() => {
        expect(serverTransport.sessions.size).toBe(1);
        expect(get).toHaveBeenCalledTimes(1);
        expect(parse).toHaveBeenCalledTimes(1);
      });

      const session = serverTransport.sessions.get(clientTransport.clientId);
      assert(session);
      expect(serverTransport.sessionHandshakeMetadata.get(session)).toEqual({
        kept: 'kept',
      });

      await waitFor(() => expect(clientTransport.connections.size).toBe(1));
      expect(serverTransport.connections.size).toBe(1);
    });

    test('client checks request schema on construction', async () => {
      const schema = Type.Object({
        foo: Type.String(),
      });
      const get = vi.fn(async () => ({ foo: false }));
      const parse = vi.fn(async (metadata: unknown) => ({
        // @ts-expect-error - we haven't extended the global type here
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        foo: metadata.foo,
      }));

      const serverTransport = getServerTransport({
        schema,
        validate: parse,
      });
      const clientTransport = getClientTransport('client', {
        schema,
        construct: get,
      });

      const clientHandshakeFailed = vi.fn();
      clientTransport.addEventListener('protocolError', clientHandshakeFailed);

      onTestFinished(async () => {
        clientTransport.removeEventListener(
          'protocolError',
          clientHandshakeFailed,
        );

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
        });
      });

      await waitFor(() => {
        expect(get).toHaveBeenCalledTimes(1);
        expect(clientHandshakeFailed).toHaveBeenCalledTimes(1);
        expect(clientHandshakeFailed).toHaveBeenCalledWith(
          expect.objectContaining({
            type: ProtocolError.HandshakeFailed,
          }),
        );
        // should never get to the server
        expect(parse).toHaveBeenCalledTimes(0);
      });

      expect(clientTransport.connections.size).toBe(0);
      expect(serverTransport.connections.size).toBe(0);
    });

    test('server checks request schema on receive', async () => {
      const clientRequestSchema = Type.Object({
        foo: Type.Number(),
      });
      const serverRequestSchema = Type.Object({
        foo: Type.Boolean(),
      });

      const get = vi.fn(async () => ({ foo: 123 }));
      const parse = vi.fn(async (metadata: unknown) => ({
        // @ts-expect-error - we haven't extended the global type here
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        foo: metadata.foo,
      }));

      const serverTransport = getServerTransport({
        schema: serverRequestSchema,
        validate: parse,
      });

      const clientTransport = getClientTransport('client', {
        schema: clientRequestSchema,
        construct: get,
      });

      const clientHandshakeFailed = vi.fn();
      clientTransport.addEventListener('protocolError', clientHandshakeFailed);
      const serverHandshakeFailed = vi.fn();
      serverTransport.addEventListener('protocolError', serverHandshakeFailed);

      onTestFinished(async () => {
        clientTransport.removeEventListener(
          'protocolError',
          clientHandshakeFailed,
        );
        serverTransport.removeEventListener(
          'protocolError',
          serverHandshakeFailed,
        );

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
        });
      });

      await waitFor(() => {
        expect(get).toHaveBeenCalledTimes(1);
        expect(clientHandshakeFailed).toHaveBeenCalledTimes(1);
        expect(clientHandshakeFailed).toHaveBeenCalledWith(
          expect.objectContaining({
            type: ProtocolError.HandshakeFailed,
          }),
        );
        expect(parse).toHaveBeenCalledTimes(0);
        expect(serverHandshakeFailed).toHaveBeenCalledTimes(1);
        expect(serverHandshakeFailed).toHaveBeenCalledWith(
          expect.objectContaining({
            type: ProtocolError.HandshakeFailed,
          }),
        );
      });
    });

    test('server gets previous parsed metadata on reconnect', async () => {
      const schema = Type.Object({
        kept: Type.String(),
        discarded: Type.String(),
      });
      const construct = vi.fn(async () => ({
        kept: 'kept',
        discarded: 'discarded',
      }));

      const validate = vi.fn(async (metadata: unknown, _previous: unknown) => ({
        // @ts-expect-error - we haven't extended the global type here
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        kept: metadata.kept,
      }));

      const serverTransport = getServerTransport({ schema, validate });
      const clientTransport = getClientTransport('client', {
        schema,
        construct,
      });

      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
        });
      });

      await waitFor(() => expect(serverTransport.sessions.size).toBe(1));
      expect(construct).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledWith(
        {
          kept: 'kept',
          discarded: 'discarded',
        },
        undefined,
      );

      const session = serverTransport.sessions.get(clientTransport.clientId);
      assert(session);
      expect(serverTransport.sessionHandshakeMetadata.get(session)).toEqual({
        kept: 'kept',
      });

      await waitFor(() => expect(clientTransport.connections.size).toBe(1));
      expect(serverTransport.connections.size).toBe(1);

      // now, let's wait until the connection is considered dead
      clientTransport.connections.forEach((conn) => conn.close());
      await waitFor(() => expect(clientTransport.connections.size).toBe(0));

      // should have reconnected by now
      await waitFor(() => expect(clientTransport.connections.size).toBe(1));
      await waitFor(() => expect(serverTransport.connections.size).toBe(1));

      expect(validate).toHaveBeenCalledTimes(2);
      expect(validate).toHaveBeenCalledWith(
        {
          kept: 'kept',
          discarded: 'discarded',
        },
        {
          kept: 'kept',
        },
      );
    });

    test('parse can reject connection', async () => {
      const schema = Type.Object({
        foo: Type.String(),
      });

      const get = vi.fn(async () => ({ foo: 'foo' }));
      const parse = vi.fn(async () => false);
      const serverTransport = getServerTransport({
        schema,
        validate: parse,
      });

      const clientTransport = getClientTransport('client', {
        schema,
        construct: get,
      });

      const clientHandshakeFailed = vi.fn();
      clientTransport.addEventListener('protocolError', clientHandshakeFailed);
      const serverRejectedConnection = vi.fn();
      serverTransport.addEventListener(
        'protocolError',
        serverRejectedConnection,
      );

      onTestFinished(async () => {
        clientTransport.removeEventListener(
          'protocolError',
          clientHandshakeFailed,
        );
        serverTransport.removeEventListener(
          'protocolError',
          serverRejectedConnection,
        );

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
        });
      });

      await waitFor(() => {
        expect(clientHandshakeFailed).toHaveBeenCalledTimes(1);
        expect(clientHandshakeFailed).toHaveBeenCalledWith({
          type: ProtocolError.HandshakeFailed,
          message: 'rejected by handshake handler',
        });
        expect(parse).toHaveBeenCalledTimes(1);
        expect(serverRejectedConnection).toHaveBeenCalledTimes(1);
        expect(serverRejectedConnection).toHaveBeenCalledWith({
          type: ProtocolError.HandshakeFailed,
          message: 'rejected by handshake handler',
        });
      });
    });
  },
);
