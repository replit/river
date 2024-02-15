import { describe, test, expect, afterAll, vi } from 'vitest';
import {
  createDummyTransportMessage,
  waitForMessage,
} from '../util/testHelpers';
import { EventMap } from '../transport/events';
import { transports } from '../__tests__/fixtures/transports';
import { testFinishesCleanly, waitFor } from '../__tests__/fixtures/cleanup';

describe.each(transports)('transport -- $name', async ({ setup }) => {
  const { getTransports, cleanup } = await setup();

  afterAll(cleanup);
  test('connection is recreated after clean disconnect', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const msg1Promise = waitForMessage(
      serverTransport,
      (recv) => recv.id === msg1.id,
    );
    clientTransport.send(msg1);
    await expect(msg1Promise).resolves.toStrictEqual(msg1.payload);

    // clean disconnect
    clientTransport.connections.forEach((conn) => conn.close());
    const msg2Promise = waitForMessage(
      serverTransport,
      (recv) => recv.id === msg2.id,
    );

    // by this point the client should have reconnected
    clientTransport.send(msg2);
    await expect(msg2Promise).resolves.toStrictEqual(msg2.payload);
    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });

  test('both client and server transport gets connection and disconnection notifs', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const onClientConnect = vi.fn();
    const onClientDisconnect = vi.fn();
    const clientHandler = (evt: EventMap['connectionStatus']) => {
      if (evt.status === 'connect') return onClientConnect();
      if (evt.status === 'disconnect') return onClientDisconnect();
    };

    const onServerConnect = vi.fn();
    const onServerDisconnect = vi.fn();
    const serverHandler = (evt: EventMap['connectionStatus']) => {
      if (evt.status === 'connect') return onServerConnect();
      if (evt.status === 'disconnect') return onServerDisconnect();
    };

    clientTransport.addEventListener('connectionStatus', clientHandler);
    serverTransport.addEventListener('connectionStatus', serverHandler);

    expect(onClientConnect).toHaveBeenCalledTimes(0);
    expect(onClientDisconnect).toHaveBeenCalledTimes(0);
    expect(onServerConnect).toHaveBeenCalledTimes(0);
    expect(onServerDisconnect).toHaveBeenCalledTimes(0);

    const msg1Promise = waitForMessage(
      serverTransport,
      (recv) => recv.id === msg1.id,
    );
    clientTransport.send(msg1);
    await expect(msg1Promise).resolves.toStrictEqual(msg1.payload);

    expect(onClientConnect).toHaveBeenCalledTimes(1);
    expect(onClientDisconnect).toHaveBeenCalledTimes(0);
    expect(onServerConnect).toHaveBeenCalledTimes(1);
    expect(onServerDisconnect).toHaveBeenCalledTimes(0);

    // clean disconnect
    clientTransport.connections.forEach((conn) => conn.close());

    // wait for connection status to propagate to server
    await waitFor(() => expect(onClientConnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClientDisconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onServerConnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onServerDisconnect).toHaveBeenCalledTimes(1));

    const msg2Promise = waitForMessage(
      serverTransport,
      (recv) => recv.id === msg2.id,
    );

    // by this point the client should have reconnected
    clientTransport.send(msg2);
    await expect(msg2Promise).resolves.toStrictEqual(msg2.payload);
    expect(onClientConnect).toHaveBeenCalledTimes(2);
    expect(onClientDisconnect).toHaveBeenCalledTimes(1);
    expect(onServerConnect).toHaveBeenCalledTimes(2);
    expect(onServerDisconnect).toHaveBeenCalledTimes(1);

    // teardown
    clientTransport.removeEventListener('connectionStatus', clientHandler);
    serverTransport.removeEventListener('connectionStatus', serverHandler);
    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });

  test('ws connection is not recreated after destroy', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const msg1 = createDummyTransportMessage();
    const msg2 = createDummyTransportMessage();

    const promise1 = waitForMessage(
      serverTransport,
      (recv) => recv.id === msg1.id,
    );
    clientTransport.send(msg1);
    await expect(promise1).resolves.toStrictEqual(msg1.payload);

    clientTransport.destroy();
    expect(() => clientTransport.send(msg2)).toThrow(
      new Error('transport is destroyed, cant send'),
    );

    // this is not expected to be clean because we destroyed the transport
    expect(clientTransport.state).toEqual('destroyed');
    await clientTransport.close();
    await serverTransport.close();
  });
});
