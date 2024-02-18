import { expect, vi } from 'vitest';
import { Connection, OpaqueTransportMessage, Transport } from '../../transport';
import { Server } from '../../router';
import { DISCONNECT_GRACE_MS } from '../../transport/session';

const waitUntilOptions = {
  timeout: 250, // these are all local connections so anything above 250ms is sus
  interval: 5, // check every 5ms
};

export async function waitForTransportToFinish(t: Transport<Connection>) {
  // await ensureTransportQueuesAreEventuallyEmpty(t);
  // ^ this is buggy because current protocol sometimes drops acks
  //   should be fixed when we rewrite our acks to be more reliable
  await t.close();

  // advance fake timer so we hit the disconnect grace to end the session
  await vi.runOnlyPendingTimersAsync();
  await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + 1);
}

async function ensureTransportIsClean(t: Transport<Connection>) {
  expect(
    t.state,
    `transport ${t.clientId} should be closed after the test`,
  ).to.not.equal('open');
  const promises = [
    waitFor(() =>
      expect(
        t.sessions,
        `transport ${t.clientId} should not have open sessions after the test`,
      ).toStrictEqual(new Map()),
    ),
    waitFor(() =>
      expect(
        t.connections,
        `transport ${t.clientId} should not have open connections after the test`,
      ).toStrictEqual(new Map()),
    ),
    waitFor(() =>
      expect(
        t.eventDispatcher.numberOfListeners('message'),
        `transport ${t.clientId} should not have open message handlers after the test`,
      ).equal(0),
    ),
    waitFor(() =>
      expect(
        t.eventDispatcher.numberOfListeners('connectionStatus'),
        `transport ${t.clientId} should not have open connection handlers after the test`,
      ).equal(0),
    ),
  ];

  await Promise.all(promises);
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
        [...t.sessions]
          .map(
            ([client, sess]) => [client, sess.sendQueue] as [string, string[]],
          )
          .filter((entry) => entry[1].length > 0),
      ),
      `transport ${t.clientId} should not have any messages waiting to send after the test`,
    ).toStrictEqual(new Map()),
  );
  await waitFor(() =>
    expect(
      new Map(
        [...t.sessions]
          .map(
            ([client, sess]) =>
              [client, sess.sendBuffer] as [
                string,
                Map<string, OpaqueTransportMessage>,
              ],
          )
          .filter((entry) => entry[1].size > 0),
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
  vi.useFakeTimers({ shouldAdvanceTime: true });

  if (clientTransports) {
    await Promise.all(clientTransports.map(waitForTransportToFinish));
    await Promise.all(clientTransports.map(ensureTransportIsClean));
  }

  // server sits on top of server transport so we clean it up first
  if (server) {
    await ensureServerIsClean(server);
    await server.close();
  }

  if (serverTransport) {
    await waitForTransportToFinish(serverTransport);
    await ensureTransportIsClean(serverTransport);
  }

  vi.useRealTimers();
}
