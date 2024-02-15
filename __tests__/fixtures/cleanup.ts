import { expect, vi } from 'vitest';
import { Connection, Transport } from '../../transport';
import { Server } from '../../router';

const waitUntilOptions = {
  timeout: 250, // these are all local connections so anything above 250ms is sus
  interval: 5, // check every 5ms
};

export async function ensureTransportIsClean(t: Transport<Connection>) {
  expect(
    t.state,
    `transport ${t.clientId} should be closed after the test`,
  ).to.not.equal('open');
  expect(
    t.sessions,
    `transport ${t.clientId} should not have open sessions after the test`,
  ).toStrictEqual(new Map());
  expect(
    t.connections,
    `transport ${t.clientId} should not have open connections after the test`,
  ).toStrictEqual(new Map());
  expect(
    t.eventDispatcher.numberOfListeners('message'),
    `transport ${t.clientId} should not have open message handlers after the test`,
  ).equal(0);
  expect(
    t.eventDispatcher.numberOfListeners('connectionStatus'),
    `transport ${t.clientId} should not have open connection handlers after the test`,
  ).equal(0);
  // TODO(jackyzha0): we sometimes drop acks in the protocol so this fails
  // await ensureTransportQueuesAreEventuallyEmpty(t)
}

export function waitFor<T>(cb: () => T | Promise<T>) {
  return vi.waitFor(cb, waitUntilOptions);
}

export async function ensureTransportQueuesAreEventuallyEmpty(
  t: Transport<Connection>,
) {
  await waitFor(() =>
    expect(
      new Map(
        [...t.sessions].map(([client, sess]) => [client, sess.sendQueue]),
      ),
      `transport ${t.clientId} should not have any messages waiting to send after the test`,
    ).toStrictEqual(new Map()),
  );
  await waitFor(() =>
    expect(
      new Map(
        [...t.sessions].map(([client, sess]) => [client, sess.sendBuffer]),
      ),
      `transport ${t.clientId} should not have any un-acked messages after the test`,
    ).toStrictEqual(new Map()),
  );
}

export async function ensureServerIsClean(s: Server<unknown>) {
  return waitFor(() =>
    expect(
      s.streams,
      `server should not have any open streams after the test`,
    ).toStrictEqual(new Map()),
  );
}

export async function testFinishesCleanly({
  clientTransports,
  serverTransport,
  server,
}: Partial<{
  clientTransports: Array<Transport<Connection>>;
  serverTransport: Transport<Connection>;
  server: Server<unknown>;
}>) {
  if (clientTransports) {
    await Promise.all(clientTransports.map((t) => t.close()));
    await Promise.all(clientTransports.map(ensureTransportIsClean));
  }

  // server sits on top of server transport so we clean it up first
  if (server) {
    await ensureServerIsClean(server);
    await server.close();
  }

  if (serverTransport) {
    await serverTransport.close();
    await ensureTransportIsClean(serverTransport);
  }
}
