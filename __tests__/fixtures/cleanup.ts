import { expect, vi } from 'vitest';
import { Connection, OpaqueTransportMessage, Transport } from '../../transport';
import { Server } from '../../router';
import {
  SESSION_DISCONNECT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
} from '../../transport/session';
import { log } from '../../logging';

const waitUntilOptions = {
  timeout: 250, // these are all local connections so anything above 250ms is sus
  interval: 5, // check every 5ms
};

export async function waitForTransportToFinish(t: Transport<Connection>) {
  await t.close();
  await waitFor(() =>
    expect(
      t.connections,
      `transport ${t.clientId} should not have open connections after the test`,
    ).toStrictEqual(new Map()),
  );
}

export async function advanceFakeTimersByDisconnectGrace() {
  // advance fake timer so we hit the disconnect grace to end the session
  await vi.runOnlyPendingTimersAsync();

  // wait for heartbeat + disconnect timer to propagate
  await vi.advanceTimersByTimeAsync(
    HEARTBEAT_INTERVAL_MS + SESSION_DISCONNECT_GRACE_MS + 1,
  );
}

async function ensureTransportIsClean(t: Transport<Connection>) {
  expect(
    t.state,
    `transport ${t.clientId} should be closed after the test`,
  ).to.not.equal('open');
  await ensureTransportBuffersAreEventuallyEmpty(t);
  await waitFor(() =>
    expect(
      t.sessions,
      `transport ${t.clientId} should not have open sessions after the test`,
    ).toStrictEqual(new Map()),
  );
  await waitFor(() =>
    expect(
      t.eventDispatcher.numberOfListeners('message'),
      `transport ${t.clientId} should not have open message handlers after the test`,
    ).equal(0),
  );
  await waitFor(() =>
    expect(
      t.eventDispatcher.numberOfListeners('sessionStatus'),
      `transport ${t.clientId} should not have open session status handlers after the test`,
    ).equal(0),
  );
  await waitFor(() =>
    expect(
      t.eventDispatcher.numberOfListeners('connectionStatus'),
      `transport ${t.clientId} should not have open connection status handlers after the test`,
    ).equal(0),
  );
}

export function waitFor<T>(cb: () => T | Promise<T>) {
  return vi.waitFor(cb, waitUntilOptions);
}

export async function ensureTransportBuffersAreEventuallyEmpty(
  t: Transport<Connection>,
) {
  await waitFor(() =>
    expect(
      new Map(
        [...t.sessions]
          .map(
            ([client, sess]) =>
              [client, sess.inspectSendBuffer()] as [
                string,
                readonly OpaqueTransportMessage[],
              ],
          )
          .filter((entry) => entry[1].length > 0),
      ),
      `transport ${t.clientId} should not have any messages waiting to send after the test`,
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
  log?.info('*** end of test cleanup ***');
  vi.useFakeTimers({ shouldAdvanceTime: true });

  if (clientTransports) {
    await Promise.all(clientTransports.map(waitForTransportToFinish));
    await advanceFakeTimersByDisconnectGrace();
    await Promise.all(clientTransports.map(ensureTransportIsClean));
  }

  // server sits on top of server transport so we clean it up first
  if (server) {
    await ensureServerIsClean(server);
    await server.close();
  }

  if (serverTransport) {
    await waitForTransportToFinish(serverTransport);
    await advanceFakeTimersByDisconnectGrace();
    await ensureTransportIsClean(serverTransport);
  }

  vi.useRealTimers();
}
