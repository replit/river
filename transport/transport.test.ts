import { describe, test, expect, afterAll, vi } from 'vitest';
import {
  createDummyTransportMessage,
  waitForMessage,
} from '../util/testHelpers';
import { EventMap } from '../transport/events';
import { transports } from '../__tests__/fixtures/transports';
import {
  advanceFakeTimersByDisconnectGrace,
  testFinishesCleanly,
  waitFor,
} from '../__tests__/fixtures/cleanup';

describe.each(transports)('transport -- $name', async ({ setup }) => {
  const { getTransports, cleanup } = await setup();
  afterAll(cleanup);

  test('connection is recreated after clean client disconnect', async () => {
    const [clientTransport, serverTransport] = getTransports();
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
    const [clientTransport, serverTransport] = getTransports();
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
    await waitFor(() => expect(clientConnDisconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(serverConnDisconnect).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(clientSessConnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(serverSessConnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(clientSessDisconnect).toHaveBeenCalledTimes(0));
    await waitFor(() => expect(serverSessDisconnect).toHaveBeenCalledTimes(0));

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
    await waitFor(() => expect(clientConnDisconnect).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(serverConnDisconnect).toHaveBeenCalledTimes(2));

    await advanceFakeTimersByDisconnectGrace();
    await waitFor(() => expect(clientSessConnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(serverSessConnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(clientSessDisconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(serverSessDisconnect).toHaveBeenCalledTimes(1));

    // teardown
    clientTransport.removeEventListener('connectionStatus', clientConnHandler);
    serverTransport.removeEventListener('connectionStatus', serverConnHandler);
    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });

  test('transport connection is not recreated after destroy', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const msg1Id = clientTransport.send(serverTransport.clientId, msg1);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg1Id),
    ).resolves.toStrictEqual(msg1.payload);

    await clientTransport.destroy();
    expect(() => clientTransport.send(serverTransport.clientId, msg2)).toThrow(
      new Error('transport is destroyed, cant send'),
    );

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
});
