import { describe, test, expect, vi, assert, beforeEach } from 'vitest';
import {
  createDummyTransportMessage,
  payloadToTransportMessage,
  waitForMessage,
  closeAllConnections,
  numberOfConnections,
  testingClientSessionOptions,
  getClientSendFn,
  getServerSendFn,
} from '../testUtil';
import { EventMap, ProtocolError } from '../transport/events';
import {
  advanceFakeTimersByConnectionBackoff,
  advanceFakeTimersByDisconnectGrace,
  advanceFakeTimersByHeartbeat,
  advanceFakeTimersBySessionGrace,
  cleanupTransports,
  testFinishesCleanly,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import { testMatrix } from '../testUtil/fixtures/matrix';
import { PartialTransportMessage } from './message';
import { Type } from '@sinclair/typebox';
import { TestSetupHelpers } from '../testUtil/fixtures/transports';
import { createPostTestCleanups } from '../testUtil/fixtures/cleanup';
import { SessionState } from './sessionStateMachine';
import {
  ProvidedClientTransportOptions,
  ProvidedTransportOptions,
} from './options';

describe.each(testMatrix())(
  'transport connection behaviour tests ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };

    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    test('connection is recreated after clean client disconnect', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      clientTransport.connect(serverTransport.clientId);
      const clientSendFn = getClientSendFn(clientTransport, serverTransport);

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const msg1 = createDummyTransportMessage();
      const msg2 = createDummyTransportMessage();

      const msg1Id = clientSendFn(msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      // make sure both sides agree on the session id.
      const oldClientSessionId = serverTransport.sessions.get('client')?.id;
      const oldServerSessionId = clientTransport.sessions.get('SERVER')?.id;
      expect(oldServerSessionId).not.toBeUndefined();
      expect(oldClientSessionId).not.toBeUndefined();
      expect(oldClientSessionId).toBe(oldServerSessionId);
      expect(oldServerSessionId).toBe(oldClientSessionId);

      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      // by this point the client should have reconnected
      const msg2Id = clientSendFn(msg2);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg2Id),
      ).resolves.toStrictEqual(msg2.payload);

      // make sure both sides still have the same sessions
      const newClientSession = serverTransport.sessions.get('client');
      const newServerSession = clientTransport.sessions.get('SERVER');
      expect(newClientSession).not.toBeUndefined();
      expect(newServerSession).not.toBeUndefined();
      expect(newClientSession?.id).toBe(oldClientSessionId);
      expect(newServerSession?.id).toBe(oldServerSessionId);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('misbehaving clients get their sessions recreated after reconnect', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      clientTransport.connect(serverTransport.clientId);
      let clientSendFn = getClientSendFn(clientTransport, serverTransport);

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const msg1 = createDummyTransportMessage();
      const msg2 = createDummyTransportMessage();

      const msg1Id = clientSendFn(msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      // make sure both sides agree on the session id.
      const oldClientSessionId = clientTransport.sessions.get('SERVER')?.id;
      const oldServerSessionId = serverTransport.sessions.get('client')?.id;
      expect(oldServerSessionId).not.toBeUndefined();
      expect(oldClientSessionId).not.toBeUndefined();
      expect(oldClientSessionId).toBe(oldServerSessionId);
      expect(oldServerSessionId).toBe(oldClientSessionId);

      // make this client seem misbehaved by tweaking the seq number
      const clientSession = clientTransport.sessions.get('SERVER');
      if (clientSession) {
        if (clientSession.sendBuffer.length > 0) {
          clientSession.sendBuffer[0].seq += 10;
        } else {
          clientSession.seq += 10;
        }
      }

      // disconnect and wait for reconnection
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      // wait a bit to let the reconnect budget restore
      await advanceFakeTimersByConnectionBackoff();
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));

      // by this point the client should have reconnected
      clientSendFn = getClientSendFn(clientTransport, serverTransport);
      const msg2Id = clientSendFn(msg2);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg2Id),
      ).resolves.toStrictEqual(msg2.payload);

      // make sure both sides now have different sessions
      const newClientSession = serverTransport.sessions.get('client');
      const newServerSession = clientTransport.sessions.get('SERVER');
      expect(newClientSession).not.toBeUndefined();
      expect(newServerSession).not.toBeUndefined();
      expect(newClientSession?.id).not.toBe(oldClientSessionId);
      expect(newServerSession?.id).not.toBe(oldServerSessionId);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('idle transport cleans up nicely', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      clientTransport.connect(serverTransport.clientId);
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('idle transport stays alive', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      clientTransport.connect(serverTransport.clientId);
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => {
        expect(numberOfConnections(serverTransport)).toBe(1);
        expect(numberOfConnections(clientTransport)).toBe(1);
      });

      const oldClientSessionId = serverTransport.sessions.get('client')?.id;
      const oldServerSessionId = clientTransport.sessions.get('SERVER')?.id;
      expect(oldClientSessionId).not.toBeUndefined();
      expect(oldServerSessionId).not.toBeUndefined();

      await advanceFakeTimersBySessionGrace();
      await waitFor(() => {
        expect(numberOfConnections(serverTransport)).toBe(1);
        expect(numberOfConnections(clientTransport)).toBe(1);
      });
      const newClientSessionId = serverTransport.sessions.get('client')?.id;
      const newServerSessionId = clientTransport.sessions.get('SERVER')?.id;
      expect(newClientSessionId).toBe(oldClientSessionId);
      expect(newServerSessionId).toBe(oldServerSessionId);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('heartbeats should not interrupt normal operation', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      clientTransport.connect(serverTransport.clientId);
      const clientSendFn = getClientSendFn(clientTransport, serverTransport);

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      clientTransport.connect(serverTransport.clientId);
      for (let i = 0; i < 5; i++) {
        const msg = createDummyTransportMessage();
        const msg1Id = clientSendFn(msg);
        await expect(
          waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
        ).resolves.toStrictEqual(msg.payload);

        // wait for heartbeat interval to elapse
        await advanceFakeTimersByHeartbeat();
      }

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('sending right after session event should not cause invalid handshake', async () => {
      const clientTransport = getClientTransport('client');
      const protocolError = vi.fn();
      clientTransport.addEventListener('protocolError', protocolError);
      const serverTransport = getServerTransport();

      const msg = createDummyTransportMessage();
      const msgPromise = waitForMessage(serverTransport);
      const sendHandle = (evt: EventMap['sessionStatus']) => {
        if (evt.status === 'created') {
          getClientSendFn(clientTransport, serverTransport)(msg);
        }
      };

      clientTransport.addEventListener('sessionStatus', sendHandle);
      clientTransport.connect(serverTransport.clientId);

      addPostTestCleanup(async () => {
        clientTransport.removeEventListener('protocolError', protocolError);
        clientTransport.removeEventListener('sessionStatus', sendHandle);
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await expect(msgPromise).resolves.toStrictEqual(msg.payload);
      expect(protocolError).toHaveBeenCalledTimes(0);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('seq numbers should be persisted across transparent reconnects', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      clientTransport.connect(serverTransport.clientId);
      const clientSendFn = getClientSendFn(clientTransport, serverTransport);

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));

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
        const id = clientSendFn(msg);
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
      closeAllConnections(clientTransport);

      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      for (let i = 55; i < 90; i++) {
        const msg = first90[i];
        const id = clientSendFn(msg);
        first90Ids.push(id);
        first90Promises.push(
          waitForMessage(serverTransport, (recv) => recv.id === id),
        );
      }

      // send the last 10
      const last10 = clientMsgs.slice(90);
      const last10Ids = last10.map((msg) => clientSendFn(msg));

      // wait for the server to receive everything
      const last10Promises = last10Ids.map((id) =>
        waitForMessage(serverTransport, (recv) => recv.id === id),
      );

      clientTransport.reconnectOnConnectionDrop = true;
      clientTransport.connect(serverTransport.clientId);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));

      await expect(
        Promise.all([...first90Promises, ...last10Promises]),
      ).resolves.toStrictEqual(clientMsgs.map((msg) => msg.payload));

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('buffering messages during reconnect doesnt cause a crash', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      clientTransport.connect(serverTransport.clientId);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));

      const clientSendFn = getClientSendFn(clientTransport, serverTransport);
      const serverSendFn = getServerSendFn(serverTransport, clientTransport);

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      function sendToServer(num: number) {
        const msgs = Array.from({ length: num }, () =>
          createDummyTransportMessage(),
        );
        const ids = msgs.map((msg) => clientSendFn(msg));
        const promises = ids.map((id) =>
          waitForMessage(serverTransport, (recv) => recv.id === id),
        );

        return { msgs, promise: Promise.all(promises) };
      }

      function sendToClient(num: number) {
        const msgs = Array.from({ length: num }, () =>
          createDummyTransportMessage(),
        );
        const ids = msgs.map((msg) => serverSendFn(msg));
        const promises = ids.map((id) =>
          waitForMessage(clientTransport, (recv) => recv.id === id),
        );

        return { msgs, promise: Promise.all(promises) };
      }

      // Send initial messages to establish sequence numbers
      const { promise: initialToServer } = sendToServer(5);
      const { promise: initialToClient } = sendToClient(5);
      await Promise.all([initialToServer, initialToClient]);

      // wait for one heartbeat to elapse
      await advanceFakeTimersByHeartbeat();

      // Disconnect client and prevent auto-reconnect
      clientTransport.reconnectOnConnectionDrop = false;
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      // Buffer some messages while disconnected in both directions
      const {
        msgs: bufferedMsgsToServer,
        promise: bufferedMsgsToServerPromises,
      } = sendToServer(5);
      const {
        msgs: bufferedMsgsToClient,
        promise: bufferedMsgsToClientPromises,
      } = sendToClient(5);

      // Reconnect client
      clientTransport.reconnectOnConnectionDrop = true;
      clientTransport.connect(serverTransport.clientId);

      // Send some while still connecting in both directions
      const {
        msgs: connectingMsgsToServer,
        promise: connectingMsgsToServerPromises,
      } = sendToServer(5);
      const {
        msgs: connectingMsgsToClient,
        promise: connectingMsgsToClientPromises,
      } = sendToClient(5);

      // Wait for reconnection
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));

      // Send some new messages after reconnection in both directions
      const { msgs: newMsgsToServer, promise: newMsgPromiseToServer } =
        sendToServer(5);
      const { msgs: newMsgsToClient, promise: newMsgPromiseToClient } =
        sendToClient(5);

      // Wait for all messages to be received in correct order
      // First verify client->server messages
      await expect(
        Promise.all([
          bufferedMsgsToServerPromises,
          connectingMsgsToServerPromises,
          newMsgPromiseToServer,
        ]),
      ).resolves.toStrictEqual([
        bufferedMsgsToServer.map((msg) => msg.payload),
        connectingMsgsToServer.map((msg) => msg.payload),
        newMsgsToServer.map((msg) => msg.payload),
      ]);

      // Then verify server->client messages
      await expect(
        Promise.all([
          bufferedMsgsToClientPromises,
          connectingMsgsToClientPromises,
          newMsgPromiseToClient,
        ]),
      ).resolves.toStrictEqual([
        bufferedMsgsToClient.map((msg) => msg.payload),
        connectingMsgsToClient.map((msg) => msg.payload),
        newMsgsToClient.map((msg) => msg.payload),
      ]);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('both client and server transport get session created/closing/closed notifs', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const clientConnStart = vi.fn();
      const clientConnHandler = (evt: EventMap['sessionTransition']) => {
        switch (evt.state) {
          case SessionState.Connected:
            clientConnStart();
            break;
        }
      };

      const clientSessStart = vi.fn();
      const clientSessStopping = vi.fn();
      const clientSessStop = vi.fn();
      const clientSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'created':
            clientSessStart();
            break;
          case 'closing':
            clientSessStopping();
            break;
          case 'closed':
            clientSessStop();
            break;
        }
      };

      const serverConnStart = vi.fn();
      const serverConnHandler = (evt: EventMap['sessionTransition']) => {
        switch (evt.state) {
          case SessionState.Connected:
            serverConnStart();
            break;
        }
      };

      const serverSessStart = vi.fn();
      const serverSessStopping = vi.fn();
      const serverSessStop = vi.fn();
      const serverSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'created':
            serverSessStart();
            break;
          case 'closing':
            serverSessStopping();
            break;
          case 'closed':
            serverSessStop();
            break;
        }
      };

      clientTransport.addEventListener('sessionTransition', clientConnHandler);
      clientTransport.addEventListener('sessionStatus', clientSessHandler);
      serverTransport.addEventListener('sessionTransition', serverConnHandler);
      serverTransport.addEventListener('sessionStatus', serverSessHandler);

      addPostTestCleanup(async () => {
        // teardown
        clientTransport.removeEventListener(
          'sessionTransition',
          clientConnHandler,
        );
        clientTransport.removeEventListener('sessionStatus', clientSessHandler);
        serverTransport.removeEventListener(
          'sessionTransition',
          serverConnHandler,
        );
        serverTransport.removeEventListener('sessionStatus', serverSessHandler);
        await cleanupTransports([clientTransport, serverTransport]);
      });

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

      expect(clientSessStart).toHaveBeenCalledTimes(0);
      expect(serverSessStart).toHaveBeenCalledTimes(0);
      expect(clientSessStop).toHaveBeenCalledTimes(0);
      expect(serverSessStop).toHaveBeenCalledTimes(0);
      expect(clientSessStopping).toHaveBeenCalledTimes(0);
      expect(serverSessStopping).toHaveBeenCalledTimes(0);

      clientTransport.connect(serverTransport.clientId);
      const clientSendFn = getClientSendFn(clientTransport, serverTransport);
      const msg1Id = clientSendFn(msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      // session    >  c--| (connected)
      // connection >  c--| (connected)
      expect(clientConnStart).toHaveBeenCalledTimes(1);
      expect(serverConnStart).toHaveBeenCalledTimes(1);

      expect(clientSessStart).toHaveBeenCalledTimes(1);
      expect(serverSessStart).toHaveBeenCalledTimes(1);
      expect(clientSessStop).toHaveBeenCalledTimes(0);
      expect(serverSessStop).toHaveBeenCalledTimes(0);
      expect(clientSessStopping).toHaveBeenCalledTimes(0);
      expect(serverSessStopping).toHaveBeenCalledTimes(0);

      // clean disconnect + reconnect within grace period
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      // wait for connection status to propagate to server
      // session    >  c------| (connected)
      // connection >  c--x   | (disconnected)
      await waitFor(() => expect(clientConnStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverConnStart).toHaveBeenCalledTimes(1));

      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(0));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(0));
      await waitFor(() => expect(clientSessStopping).toHaveBeenCalledTimes(0));
      await waitFor(() => expect(serverSessStopping).toHaveBeenCalledTimes(0));

      // by this point the client should have reconnected
      // session    >  c----------| (connected)
      // connection >  c--x   c---| (connected)
      const msg2Id = clientSendFn(msg2);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg2Id),
      ).resolves.toStrictEqual(msg2.payload);
      expect(clientConnStart).toHaveBeenCalledTimes(2);
      expect(serverConnStart).toHaveBeenCalledTimes(2);

      expect(clientSessStart).toHaveBeenCalledTimes(1);
      expect(clientSessStop).toHaveBeenCalledTimes(0);
      expect(serverSessStart).toHaveBeenCalledTimes(1);
      expect(serverSessStop).toHaveBeenCalledTimes(0);
      expect(clientSessStopping).toHaveBeenCalledTimes(0);
      expect(serverSessStopping).toHaveBeenCalledTimes(0);

      // disconnect session entirely
      // session    >  c------------x  | (disconnected)
      // connection >  c--x   c-----x  | (disconnected)
      clientTransport.reconnectOnConnectionDrop = false;
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      await advanceFakeTimersBySessionGrace();
      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStopping).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStopping).toHaveBeenCalledTimes(1));

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('transport connection is not recreated after destroy', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      clientTransport.connect(serverTransport.clientId);
      const clientSendFn = getClientSendFn(clientTransport, serverTransport);

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const msg1 = createDummyTransportMessage();
      const msg1Id = clientSendFn(msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      clientTransport.close();

      // this is not expected to be clean because we closed the transport
      expect(clientTransport.getStatus()).toEqual('closed');
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));

      clientTransport.close();
      serverTransport.close();
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
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
        client.connect(serverId);

        // client to server
        const initMsg = makeDummyMessage('hello\nserver');
        const initMsgId = getClientSendFn(client, serverTransport)(initMsg);
        await expect(
          waitForMessage(serverTransport, (recv) => recv.id === initMsgId),
        ).resolves.toStrictEqual(initMsg.payload);

        return client;
      };

      const client1Transport = await initClient(clientId1);
      const client2Transport = await initClient(clientId2);
      addPostTestCleanup(async () => {
        await cleanupTransports([
          client1Transport,
          client2Transport,
          serverTransport,
        ]);
      });

      // sending messages from server to client shouldn't leak between clients
      const msg1 = makeDummyMessage('hello\nclient1');
      const msg2 = makeDummyMessage('hello\nclient2');
      const msg1Id = getServerSendFn(serverTransport, client1Transport)(msg1);
      const msg2Id = getServerSendFn(serverTransport, client2Transport)(msg2);

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

    test('listening on session disconnect and manually reconnecting works', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      clientTransport.connect(serverTransport.clientId);

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));

      const onSessionDisconnect = vi.fn();
      const onSessionConnect = vi.fn();
      const sessionStatusListener = (evt: EventMap['sessionStatus']) => {
        if (evt.status === 'created') {
          onSessionConnect();
        }

        if (evt.status === 'closed') {
          onSessionDisconnect();
          clientTransport.connect(serverTransport.clientId);
        }
      };

      clientTransport.addEventListener('sessionStatus', sessionStatusListener);
      addPostTestCleanup(async () => {
        clientTransport.removeEventListener(
          'sessionStatus',
          sessionStatusListener,
        );
      });

      expect(onSessionDisconnect).toHaveBeenCalledTimes(0);
      expect(onSessionDisconnect).toHaveBeenCalledTimes(0);

      // cause a session disconnect
      clientTransport.hardDisconnect();

      await waitFor(() => expect(onSessionDisconnect).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(onSessionConnect).toHaveBeenCalledTimes(1));

      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });
  },
);

describe.each(testMatrix())(
  'transport disabling transparent reconnect ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts: ProvidedTransportOptions = {
      codec: codec.codec,
      enableTransparentSessionReconnects: false,
    };

    let testHelpers: TestSetupHelpers;
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    beforeEach(async () => {
      testHelpers = await transport.setup({ client: opts, server: opts });
      getClientTransport = testHelpers.getClientTransport;
      getServerTransport = testHelpers.getServerTransport;

      return async () => {
        await postTestCleanup();
        await testHelpers.cleanup();
      };
    });

    test('reconnecting with grace period of 0 should result in hard reconnect', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      clientTransport.connect(serverTransport.clientId);

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));

      const oldClientSessionId = serverTransport.sessions.get('client')?.id;
      const oldServerSessionId = clientTransport.sessions.get('SERVER')?.id;
      expect(oldClientSessionId).not.toBeUndefined();
      expect(oldServerSessionId).not.toBeUndefined();
      expect(oldClientSessionId).toBe(oldServerSessionId);

      clientTransport.reconnectOnConnectionDrop = false;
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      clientTransport.reconnectOnConnectionDrop = true;
      clientTransport.connect('SERVER');
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));

      // expect new sessions to have been created
      const newClientSessionId = serverTransport.sessions.get('client')?.id;
      const newServerSessionId = clientTransport.sessions.get('SERVER')?.id;
      expect(newClientSessionId).not.toBeUndefined();
      expect(newServerSessionId).not.toBeUndefined();
      expect(newClientSessionId).not.toBe(oldClientSessionId);
      expect(newServerSessionId).not.toBe(oldServerSessionId);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });
  },
);

describe.each(testMatrix())(
  'transport handshake grace period tests ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts: ProvidedTransportOptions = {
      codec: codec.codec,
      sessionDisconnectGraceMs: 10_000,
      // setting session grace to be higher so that only handshake grace passes
      handshakeTimeoutMs: 500,
    };

    const clientOpts: ProvidedClientTransportOptions = {
      ...opts,
      attemptBudgetCapacity: 1,
    };

    let testHelpers: TestSetupHelpers;
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    beforeEach(async () => {
      testHelpers = await transport.setup({ client: clientOpts, server: opts });
      getClientTransport = testHelpers.getClientTransport;
      getServerTransport = testHelpers.getServerTransport;

      return async () => {
        await postTestCleanup();
        await testHelpers.cleanup();
      };
    });

    test('handshake grace period of 0 should lead to closed connections', async () => {
      const schema = Type.Unknown();
      const get = vi.fn();

      const parse = vi.fn(() => {
        const promise = new Promise<object>(() => {
          // noop we never want this to return
        });

        return promise;
      });

      const serverTransport = getServerTransport('SERVER', {
        schema,
        validate: parse,
      });
      const clientTransport = getClientTransport('client', {
        schema,
        construct: get,
      });
      clientTransport.connect(serverTransport.clientId);

      const protocolError = vi.fn();
      clientTransport.addEventListener('protocolError', protocolError);

      addPostTestCleanup(async () => {
        clientTransport.removeEventListener('protocolError', protocolError);
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => {
        expect(get).toHaveBeenCalledTimes(1);
        expect(parse).toHaveBeenCalledTimes(1);
      });

      // timeout the connection that is waiting for an empty promise
      const handshakeGrace = opts.handshakeTimeoutMs ?? 500;
      await vi.advanceTimersByTimeAsync(handshakeGrace + 1);

      // expect no server session/connection to have been established due to connection timeout
      expect(serverTransport.sessions.size).toBe(0);
      expect(numberOfConnections(serverTransport)).toBe(0);
      // client should not have successfully established any connections
      expect(numberOfConnections(clientTransport)).toBe(0);

      // exhaust the retry budget to result in a protocolError.RetriesExceeded
      await vi.advanceTimersByTimeAsync(handshakeGrace + 1);

      await waitFor(() => {
        expect(protocolError).toHaveBeenCalledTimes(1);
        expect(protocolError).toHaveBeenCalledWith(
          expect.objectContaining({
            type: ProtocolError.RetriesExceeded,
          }),
        );
      });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });
  },
);

describe.each(testMatrix())(
  'transport connection edge cases ($transport.name transport, $codec.name codec)',
  ({ transport, codec }) => {
    const opts = { codec: codec.codec };
    let testHelpers: TestSetupHelpers;
    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    beforeEach(async () => {
      testHelpers = await transport.setup({ client: opts, server: opts });

      return async () => {
        await postTestCleanup();
        await testHelpers.cleanup();
      };
    });

    test('reconnecting before grace period ends should leave session intact', async () => {
      const clientTransport = testHelpers.getClientTransport('client');
      const serverTransport = testHelpers.getServerTransport();
      const onConnect = vi.fn();
      clientTransport.addEventListener('sessionTransition', (evt) => {
        if (evt.state === SessionState.Connected) {
          onConnect();
        }
      });
      clientTransport.connect(serverTransport.clientId);

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => {
        expect(onConnect).toHaveBeenCalledTimes(1);
        expect(numberOfConnections(clientTransport)).toEqual(1);
        expect(numberOfConnections(serverTransport)).toEqual(1);
      });

      const oldClientSessionId = serverTransport.sessions.get('client')?.id;
      const oldServerSessionId = clientTransport.sessions.get('SERVER')?.id;
      expect(oldClientSessionId).not.toBeUndefined();
      expect(oldServerSessionId).not.toBeUndefined();

      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      await waitFor(() => {
        expect(onConnect).toHaveBeenCalledTimes(2);
        expect(numberOfConnections(clientTransport)).toEqual(1);
        expect(numberOfConnections(serverTransport)).toEqual(1);
      });

      const newClientSessionId = serverTransport.sessions.get('client')?.id;
      const newServerSessionId = clientTransport.sessions.get('SERVER')?.id;
      expect(newClientSessionId).toBe(oldClientSessionId);
      expect(newServerSessionId).toBe(oldServerSessionId);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('client transport calling .hardDisconnect() immediately kills the session and updates bookkeeping', async () => {
      const clientTransport = testHelpers.getClientTransport('client');
      const serverTransport = testHelpers.getServerTransport();
      clientTransport.connect(serverTransport.clientId);

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => {
        expect(numberOfConnections(clientTransport)).toBe(1);
        expect(numberOfConnections(serverTransport)).toBe(1);
      });

      const oldClientSessionId = serverTransport.sessions.get('client')?.id;
      const oldServerSessionId = clientTransport.sessions.get('SERVER')?.id;
      expect(oldClientSessionId).not.toBeUndefined();
      expect(oldServerSessionId).not.toBeUndefined();

      clientTransport.hardDisconnect();

      expect(numberOfConnections(clientTransport)).toBe(0);
      expect(clientTransport.sessions.size).toBe(0);

      await advanceFakeTimersByDisconnectGrace();
      await advanceFakeTimersBySessionGrace();
      await waitFor(() => {
        expect(numberOfConnections(serverTransport)).toBe(0);
        expect(serverTransport.sessions.size).toBe(0);
      });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    // make a custom auth thing that rejects all connections
    // session grace should elapse at some point despite retry loop
    test('session grace elapses during long reconnect loop', async () => {
      let attemptNumber = 0;
      let connsReachedServer = 0;
      const schema = Type.Object({
        attemptNumber: Type.Number(),
      });
      const clientTransport = testHelpers.getClientTransport('client', {
        schema,
        construct() {
          return { attemptNumber: attemptNumber++ };
        },
      });
      const serverTransport = testHelpers.getServerTransport('SERVER', {
        schema,
        async validate(_metadata, _previousParsedMetadata) {
          connsReachedServer++;
          await new Promise((resolve) =>
            setTimeout(resolve, testingClientSessionOptions.handshakeTimeoutMs),
          );

          return {};
        },
      });

      const onSessionDisconnect = vi.fn();
      const sessionStatusListener = (evt: EventMap['sessionStatus']) => {
        if (evt.status === 'closed') {
          onSessionDisconnect();
        }
      };

      clientTransport.addEventListener('sessionStatus', sessionStatusListener);
      addPostTestCleanup(async () => {
        clientTransport.removeEventListener(
          'sessionStatus',
          sessionStatusListener,
        );
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // enter the retry loop
      let timeAdvanced = 0;
      for (
        let i = 0;
        i < testingClientSessionOptions.attemptBudgetCapacity;
        i++
      ) {
        const backoff =
          clientTransport.retryBudget.getBackoffMs() +
          testingClientSessionOptions.maxJitterMs;

        clientTransport.connect(serverTransport.clientId);

        await vi.advanceTimersByTimeAsync(backoff);
        timeAdvanced += backoff;

        if (
          timeAdvanced > testingClientSessionOptions.sessionDisconnectGraceMs
        ) {
          // ok we should have hit session disconnect grace by now
          break;
        }

        // wait for the conn attempt to reach the server
        await waitFor(() => {
          expect(connsReachedServer).toBe(i + 1);
          expect(attemptNumber).toBe(i + 1);
        });

        // wait for the artificially long handshake to finish
        await vi.advanceTimersByTimeAsync(
          testingClientSessionOptions.handshakeTimeoutMs,
        );
        timeAdvanced += testingClientSessionOptions.handshakeTimeoutMs;
      }

      expect(attemptNumber).toBeGreaterThan(1);
      expect(onSessionDisconnect).toHaveBeenCalledTimes(1);
    });

    test('messages should not be resent when the client loses all state and reconnects to the server', async () => {
      let clientTransport = testHelpers.getClientTransport('client');
      const serverTransport = testHelpers.getServerTransport();
      const serverConnStart = vi.fn();
      const serverConnHandler = (evt: EventMap['sessionTransition']) => {
        switch (evt.state) {
          case SessionState.Connected:
            serverConnStart();
            break;
        }
      };

      const serverSessStart = vi.fn();
      const serverSessStop = vi.fn();
      const serverSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'created':
            serverSessStart();
            break;
          case 'closed':
            serverSessStop();
            break;
        }
      };

      serverTransport.addEventListener('sessionTransition', serverConnHandler);
      serverTransport.addEventListener('sessionStatus', serverSessHandler);
      clientTransport.connect(serverTransport.clientId);
      let clientSendFn = getClientSendFn(clientTransport, serverTransport);

      addPostTestCleanup(async () => {
        // teardown
        serverTransport.removeEventListener(
          'sessionTransition',
          serverConnHandler,
        );
        serverTransport.removeEventListener('sessionStatus', serverSessHandler);
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const msg1 = createDummyTransportMessage();
      const msg1Id = clientSendFn(msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      await waitFor(() => expect(serverConnStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(0));
      let serverSendFn = getServerSendFn(serverTransport, clientTransport);

      // kill the client
      clientTransport.close();
      closeAllConnections(serverTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      // queue up some messages
      serverSendFn(createDummyTransportMessage());
      serverSendFn(createDummyTransportMessage());

      // create a new client transport
      // and wait for it to connect
      clientTransport = testHelpers.getClientTransport('client');
      const msgPromise = waitForMessage(
        clientTransport,
        (recv) => recv.id === msg4Id,
        true,
      );
      clientTransport.connect(serverTransport.clientId);
      await waitFor(() => expect(serverConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(1));

      // recreate send fns
      clientSendFn = getClientSendFn(clientTransport, serverTransport);
      serverSendFn = getServerSendFn(serverTransport, clientTransport);

      // when we reconnect, send another message
      const msg4 = createDummyTransportMessage();
      const msg4Id = serverSendFn(msg4);
      await expect(
        // ensure that when the server gets it, it's not msg2 or msg3
        msgPromise,
      ).resolves.toStrictEqual(msg4.payload);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('messages should not be resent when client reconnects to a different instance of the server', async () => {
      const clientTransport = testHelpers.getClientTransport('client');
      let serverTransport = testHelpers.getServerTransport();
      const clientConnStart = vi.fn();
      const clientConnHandler = (evt: EventMap['sessionTransition']) => {
        switch (evt.state) {
          case SessionState.Connected:
            clientConnStart();
            break;
        }
      };

      const clientSessStart = vi.fn();
      const clientSessStop = vi.fn();
      const clientSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'created':
            clientSessStart();
            break;
          case 'closed':
            clientSessStop();
            break;
        }
      };

      clientTransport.addEventListener('sessionTransition', clientConnHandler);
      clientTransport.addEventListener('sessionStatus', clientSessHandler);
      clientTransport.connect(serverTransport.clientId);
      let clientSendFn = getClientSendFn(clientTransport, serverTransport);

      addPostTestCleanup(async () => {
        // teardown
        clientTransport.removeEventListener(
          'sessionTransition',
          clientConnHandler,
        );
        clientTransport.removeEventListener('sessionStatus', clientSessHandler);
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const msg1 = createDummyTransportMessage();
      const msg1Id = clientSendFn(msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      // wait for heartbeat to elapse
      await advanceFakeTimersByHeartbeat();

      // make sure both sides agree on the session id.
      const oldClientSession = serverTransport.sessions.get('client');
      const oldServerSession = clientTransport.sessions.get('SERVER');
      expect(oldClientSession?.id).toBe(oldServerSession?.id);
      expect(oldServerSession?.id).toBe(oldClientSession?.id);

      expect(clientConnStart).toHaveBeenCalledTimes(1);
      expect(clientSessStart).toHaveBeenCalledTimes(1);
      expect(clientSessStop).toHaveBeenCalledTimes(0);

      // bring client side connections down and stop trying to reconnect
      clientTransport.reconnectOnConnectionDrop = false;
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      // buffer some messages
      clientSendFn(createDummyTransportMessage());
      clientSendFn(createDummyTransportMessage());

      await waitFor(() => expect(clientConnStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(0));

      // kill old server and make a new transport with the new server
      await testHelpers.restartServer();
      serverTransport = testHelpers.getServerTransport();
      expect(serverTransport.sessions.size).toBe(0);

      // eagerly reconnect client
      clientTransport.reconnectOnConnectionDrop = true;
      clientTransport.connect(serverTransport.clientId);

      await waitFor(() => expect(clientConnStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(1));
      clientSendFn = getClientSendFn(clientTransport, serverTransport);

      // make sure both sides agree on the session id after the reconnect
      const newClientSession = serverTransport.sessions.get('client');
      const newServerSession = clientTransport.sessions.get('SERVER');
      expect(newClientSession?.id).not.toBe(oldClientSession?.id);
      expect(newServerSession?.id).not.toBe(oldServerSession?.id);
      expect(newClientSession?.id).toBe(newServerSession?.id);
      expect(newServerSession?.id).toBe(newClientSession?.id);

      // when we reconnect, send another message
      const msg4 = createDummyTransportMessage();
      const msg4Id = clientSendFn(msg4);
      const msgPromise = waitForMessage(
        serverTransport,
        (recv) => recv.id === msg4Id,
      );
      await expect(msgPromise).resolves.toStrictEqual(msg4.payload);

      // disconnect and wait for reconnection.
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      await advanceFakeTimersByConnectionBackoff();

      // Ensure that the session survived the reconnection. And not just that a session was not
      // created, that it's the same session from before the reconnection.
      await waitFor(() => {
        expect(clientConnStart).toHaveBeenCalledTimes(3);
        expect(clientSessStart).toHaveBeenCalledTimes(2);
        expect(clientSessStop).toHaveBeenCalledTimes(1);
      });
      const reconnectedClientSession = serverTransport.sessions.get('client');
      const reconnectedServerSession = clientTransport.sessions.get('SERVER');
      expect(reconnectedClientSession).not.toBeUndefined();
      expect(reconnectedServerSession).not.toBeUndefined();
      expect(reconnectedClientSession?.id).toBe(newClientSession?.id);
      expect(reconnectedServerSession?.id).toBe(newServerSession?.id);

      // send one more message to ensure that the message delivery is still working
      const msg5 = createDummyTransportMessage();
      const msg5Id = clientSendFn(msg5);
      await expect(
        // ensure that when the server gets it, it's not an older message
        // true indicates to reject any other messages
        waitForMessage(serverTransport, (recv) => recv.id === msg5Id, true),
      ).resolves.toStrictEqual(msg5.payload);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('recovers from phantom disconnects', async () => {
      const clientTransport = testHelpers.getClientTransport('client');
      const serverTransport = testHelpers.getServerTransport();

      const clientSessStart = vi.fn();
      const clientSessStop = vi.fn();
      const clientSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'created':
            clientSessStart();
            break;
          case 'closed':
            clientSessStop();
            break;
        }
      };

      const serverSessStart = vi.fn();
      const serverSessStop = vi.fn();
      const serverSessHandler = (evt: EventMap['sessionStatus']) => {
        switch (evt.status) {
          case 'created':
            serverSessStart();
            break;
          case 'closed':
            serverSessStop();
            break;
        }
      };

      const serverConnStart = vi.fn();
      const serverTransitionHandler = (evt: EventMap['sessionTransition']) => {
        if (evt.state === SessionState.Connected) {
          serverConnStart();
        }
      };

      clientTransport.addEventListener('sessionStatus', clientSessHandler);
      serverTransport.addEventListener('sessionStatus', serverSessHandler);
      serverTransport.addEventListener(
        'sessionTransition',
        serverTransitionHandler,
      );
      clientTransport.connect(serverTransport.clientId);
      const clientSendFn = getClientSendFn(clientTransport, serverTransport);

      addPostTestCleanup(async () => {
        // teardown
        clientTransport.removeEventListener('sessionStatus', clientSessHandler);
        serverTransport.removeEventListener('sessionStatus', serverSessHandler);
        serverTransport.removeEventListener(
          'sessionTransition',
          serverTransitionHandler,
        );
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const msg1 = createDummyTransportMessage();
      const msg1Id = clientSendFn(msg1);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
      ).resolves.toStrictEqual(msg1.payload);

      expect(serverConnStart).toHaveBeenCalledTimes(1);
      expect(clientSessStart).toHaveBeenCalledTimes(1);
      expect(serverSessStart).toHaveBeenCalledTimes(1);
      expect(clientSessStop).toHaveBeenCalledTimes(0);
      expect(serverSessStop).toHaveBeenCalledTimes(0);

      // wait for one heartbeat to elapse
      await advanceFakeTimersByHeartbeat();

      // now, let's wait until the connection is considered dead
      testHelpers.simulatePhantomDisconnect();

      // sending messages here should eventually be received after recovering from disconnect grace
      const msg2 = createDummyTransportMessage();
      const msg2Id = clientSendFn(msg2);
      const msg2Promise = waitForMessage(
        serverTransport,
        (recv) => recv.id === msg2Id,
      );

      await advanceFakeTimersByDisconnectGrace();

      // should have reconnected by now
      await waitFor(() => expect(serverConnStart).toHaveBeenCalledTimes(2));

      // still same session
      await waitFor(() => expect(clientSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(serverSessStart).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(clientSessStop).toHaveBeenCalledTimes(0));
      await waitFor(() => expect(serverSessStop).toHaveBeenCalledTimes(0));

      // we finally get the message
      expect(await msg2Promise).toStrictEqual(msg2.payload);

      // ensure sending across the connection still works
      const msg3 = createDummyTransportMessage();
      const msg3Id = clientSendFn(msg3);
      const msg3Promise = waitForMessage(
        serverTransport,
        (recv) => recv.id === msg3Id,
      );
      await expect(msg3Promise).resolves.toStrictEqual(msg3.payload);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });
  },
);

describe.each(testMatrix())(
  'transport handshake tests ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };

    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    test('handshakes and stores parsed metadata in session', async () => {
      const schema = Type.Object({
        kept: Type.String(),
        discarded: Type.String(),
      });

      interface Metadata {
        kept: string;
      }

      const get = vi.fn(async () => ({ kept: 'kept', discarded: 'discarded' }));
      const parse = vi.fn(async (metadata: Metadata) => ({
        kept: metadata.kept,
      }));

      const serverTransport = getServerTransport('SERVER', {
        schema,
        validate: parse,
      });
      const clientTransport = getClientTransport('client', {
        schema,
        construct: get,
      });
      clientTransport.connect(serverTransport.clientId);
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => {
        expect(serverTransport.sessions.size).toBe(1);
        expect(get).toHaveBeenCalledTimes(1);
        expect(parse).toHaveBeenCalledTimes(1);
      });

      const session = serverTransport.sessions.get(clientTransport.clientId);
      assert(session);
      expect(serverTransport.sessionHandshakeMetadata.get(session.to)).toEqual({
        kept: 'kept',
      });

      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      expect(numberOfConnections(serverTransport)).toBe(1);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('client checks request schema on construction', async () => {
      const schema = Type.Object({
        foo: Type.String(),
      });

      interface Metadata {
        foo: string;
      }

      const get = vi.fn(async () => ({ foo: false }));
      const parse = vi.fn(async (metadata: Metadata) => ({
        foo: metadata.foo,
      }));

      const serverTransport = getServerTransport('SERVER', {
        schema,
        validate: parse,
      });
      const clientTransport = getClientTransport('client', {
        schema,
        construct: get,
      });
      const clientHandshakeFailed = vi.fn();
      clientTransport.addEventListener('protocolError', clientHandshakeFailed);
      clientTransport.connect(serverTransport.clientId);

      addPostTestCleanup(async () => {
        clientTransport.removeEventListener(
          'protocolError',
          clientHandshakeFailed,
        );
        await cleanupTransports([clientTransport, serverTransport]);
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

      expect(numberOfConnections(clientTransport)).toBe(0);
      expect(numberOfConnections(serverTransport)).toBe(0);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('server checks request schema on receive', async () => {
      const clientRequestSchema = Type.Object({
        foo: Type.Number(),
      });
      const serverRequestSchema = Type.Object({
        foo: Type.Boolean(),
      });

      interface Metadata {
        foo: boolean;
      }

      const get = vi.fn(async () => ({ foo: 123 }));
      const parse = vi.fn(async (metadata: Metadata) => ({
        foo: metadata.foo,
      }));

      const serverTransport = getServerTransport('SERVER', {
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
      clientTransport.connect(serverTransport.clientId);

      addPostTestCleanup(async () => {
        clientTransport.removeEventListener(
          'protocolError',
          clientHandshakeFailed,
        );
        serverTransport.removeEventListener(
          'protocolError',
          serverHandshakeFailed,
        );
        await cleanupTransports([clientTransport, serverTransport]);
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

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
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

      interface Metadata {
        kept: string;
        discarded: string;
      }

      const validate = vi.fn(
        async (metadata: Metadata, _previous: unknown) => ({
          kept: metadata.kept,
        }),
      );

      const serverTransport = getServerTransport('SERVER', {
        schema,
        validate,
      });
      const clientTransport = getClientTransport('client', {
        schema,
        construct,
      });
      clientTransport.connect(serverTransport.clientId);

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
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
      expect(serverTransport.sessionHandshakeMetadata.get(session.to)).toEqual({
        kept: 'kept',
      });

      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      expect(numberOfConnections(serverTransport)).toBe(1);

      // now, let's wait until the connection is considered dead
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      // should have reconnected by now
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));

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

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('parse can reject connection', async () => {
      const schema = Type.Object({
        foo: Type.String(),
      });

      const get = vi.fn(async () => ({ foo: 'foo' }));
      const parse = vi.fn(async () => 'REJECTED_BY_CUSTOM_HANDLER' as const);
      const serverTransport = getServerTransport('SERVER', {
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
      clientTransport.connect(serverTransport.clientId);

      addPostTestCleanup(async () => {
        clientTransport.removeEventListener(
          'protocolError',
          clientHandshakeFailed,
        );
        serverTransport.removeEventListener(
          'protocolError',
          serverRejectedConnection,
        );
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => {
        expect(clientHandshakeFailed).toHaveBeenCalledTimes(1);
        expect(clientHandshakeFailed).toHaveBeenCalledWith({
          type: ProtocolError.HandshakeFailed,
          code: 'REJECTED_BY_CUSTOM_HANDLER',
          message: 'handshake failed: rejected by handshake handler',
        });
        expect(parse).toHaveBeenCalledTimes(1);
        expect(serverRejectedConnection).toHaveBeenCalledTimes(1);
        expect(serverRejectedConnection).toHaveBeenCalledWith({
          type: ProtocolError.HandshakeFailed,
          code: 'REJECTED_BY_CUSTOM_HANDLER',
          message: 'rejected by handshake handler',
        });
      });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });
  },
);
