import { expect, vi } from 'vitest';
import { Connection, OpaqueTransportMessage, Transport } from '../../transport';
import { Server } from '../../router';
import { log } from '../../logging/log';
import { ServiceSchemaMap } from '../../router/services';
import { testingSessionOptions } from '../../util/testHelpers';

const waitUntilOptions = {
  timeout: 500, // account for possibility of conn backoff
  interval: 5, // check every 5ms
};

export async function waitForTransportToFinish(t: Transport<Connection>) {
  t.close();
  await waitFor(() =>
    expect(
      t.connections,
      `[post-test cleanup] transport ${t.clientId} should not have open connections after the test`,
    ).toStrictEqual(new Map()),
  );
}

export async function advanceFakeTimersByDisconnectGrace() {
  for (let i = 0; i < testingSessionOptions.heartbeatsUntilDead; i++) {
    // wait for heartbeat interval to elapse
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(
      testingSessionOptions.heartbeatIntervalMs + 1,
    );
  }
}

export async function advanceFakeTimersBySessionGrace() {
  await advanceFakeTimersByDisconnectGrace();
  await vi.runOnlyPendingTimersAsync();
  await vi.advanceTimersByTimeAsync(
    testingSessionOptions.sessionDisconnectGraceMs + 1,
  );
}

async function ensureTransportIsClean(t: Transport<Connection>) {
  expect(
    t.state,
    `[post-test cleanup] transport ${t.clientId} should be closed after the test`,
  ).to.not.equal('open');

  await ensureTransportBuffersAreEventuallyEmpty(t);
  await waitFor(() =>
    expect(
      t.sessions,
      `[post-test cleanup] transport ${t.clientId} should not have open sessions after the test`,
    ).toStrictEqual(new Map()),
  );

  expect(
    t.eventDispatcher.numberOfListeners('message'),
    `[post-test cleanup] transport ${t.clientId} should not have open message handlers after the test`,
  ).equal(0);

  expect(
    t.eventDispatcher.numberOfListeners('sessionStatus'),
    `[post-test cleanup] transport ${t.clientId} should not have open session status handlers after the test`,
  ).equal(0);

  expect(
    t.eventDispatcher.numberOfListeners('connectionStatus'),
    `[post-test cleanup] transport ${t.clientId} should not have open connection status handlers after the test`,
  ).equal(0);
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
                ReadonlyArray<OpaqueTransportMessage>,
              ],
          )
          .filter((entry) => entry[1].length > 0),
      ),
      `[post-test cleanup] transport ${t.clientId} should not have any messages waiting to send after the test`,
    ).toStrictEqual(new Map()),
  );
}

export async function ensureServerIsClean(s: Server<ServiceSchemaMap>) {
  return waitFor(() =>
    expect(
      s.streams,
      `[post-test cleanup] server should not have any open streams after the test`,
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
  server: Server<ServiceSchemaMap>;
}>) {
  log?.info('*** end of test cleanup ***');
  vi.useFakeTimers({ shouldAdvanceTime: true });

  if (clientTransports) {
    await Promise.all(clientTransports.map(waitForTransportToFinish));
    await advanceFakeTimersBySessionGrace();
    await Promise.all(clientTransports.map(ensureTransportIsClean));
  }

  // server sits on top of server transport so we clean it up first
  if (server) {
    await advanceFakeTimersBySessionGrace();
    await ensureServerIsClean(server);
    await server.close();
  }

  if (serverTransport) {
    await waitForTransportToFinish(serverTransport);
    await advanceFakeTimersBySessionGrace();
    await ensureTransportIsClean(serverTransport);
  }

  vi.useRealTimers();
}
