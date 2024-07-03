import { expect, vi } from 'vitest';
import {
  ClientTransport,
  Connection,
  OpaqueTransportMessage,
  ServerTransport,
  Transport,
} from '../../transport';
import { Server } from '../../router';
import { AnyServiceSchemaMap } from '../../router/services';
import {
  numberOfConnections,
  testingSessionOptions,
} from '../../util/testHelpers';
import { Value } from '@sinclair/typebox/value';
import { ControlMessageAckSchema } from '../../transport/message';

const waitUntilOptions = {
  timeout: 500, // account for possibility of conn backoff
  interval: 5, // check every 5ms
};

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

export async function advanceFakeTimersByConnectionBackoff() {
  await vi.advanceTimersByTimeAsync(500);
}

export async function ensureTransportIsClean(t: Transport<Connection>) {
  await advanceFakeTimersBySessionGrace();
  await waitFor(() =>
    expect(
      t.sessions,
      `[post-test cleanup] transport ${t.clientId} should not have open sessions after the test`,
    ).toStrictEqual(new Map()),
  );
  await waitFor(() =>
    expect(
      numberOfConnections(t),
      `[post-test cleanup] transport ${t.clientId} should not have open connections after the test`,
    ).toStrictEqual(new Map()),
  );
}

export function waitFor<T>(cb: () => T | Promise<T>) {
  return vi.waitFor(cb, waitUntilOptions);
}

export async function ensureTransportBuffersAreEventuallyEmpty(
  t: Transport<Connection>,
) {
  // wait for send buffers to be flushed
  // ignore heartbeat messages
  await waitFor(() =>
    expect(
      new Map(
        [...t.sessions]
          .map(([client, sess]) => {
            // get all messages that are not heartbeats
            const buff = sess.sendBuffer.filter((msg) => {
              return !Value.Check(ControlMessageAckSchema, msg.payload);
            });

            return [client, buff] as [
              string,
              ReadonlyArray<OpaqueTransportMessage>,
            ];
          })
          .filter((entry) => entry[1].length > 0),
      ),
      `[post-test cleanup] transport ${t.clientId} should not have any messages waiting to send after the test`,
    ).toStrictEqual(new Map()),
  );
}

export async function ensureServerIsClean(s: Server<AnyServiceSchemaMap>) {
  return waitFor(() =>
    expect(
      s.streams,
      `[post-test cleanup] server should not have any open streams after the test`,
    ).toStrictEqual(new Map()),
  );
}

export async function cleanupTransports<ConnType extends Connection>(
  transports: Array<Transport<ConnType>>,
) {
  for (const t of transports) {
    if (t.getStatus() !== 'closed') {
      t.log?.info('*** end of test cleanup ***', { clientId: t.clientId });
      t.close();
    }
  }
}

export async function testFinishesCleanly({
  clientTransports,
  serverTransport,
  server,
}: Partial<{
  clientTransports: Array<ClientTransport<Connection>>;
  serverTransport: ServerTransport<Connection>;
  server: Server<AnyServiceSchemaMap>;
}>) {
  // pre-close invariants
  const allTransports = [
    ...(clientTransports ?? []),
    ...(serverTransport ? [serverTransport] : []),
  ];

  for (const t of allTransports) {
    t.log?.info('*** end of test invariant checks ***', {
      clientId: t.clientId,
    });

    // wait for one round of heartbeat
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(
      testingSessionOptions.heartbeatIntervalMs + 1,
    );
    await ensureTransportBuffersAreEventuallyEmpty(t);
  }

  if (server) {
    await ensureServerIsClean(server);
  }

  // close all the things
  await cleanupTransports(allTransports);

  // post-close invariants
  for (const t of allTransports) {
    await ensureTransportIsClean(t);
  }
}

export const createPostTestCleanups = () => {
  const cleanupFns: Array<() => Promise<void>> = [];
  return {
    addPostTestCleanup: (fn: () => Promise<void>) => {
      cleanupFns.push(fn);
    },
    postTestCleanup: async () => {
      while (cleanupFns.length > 0) {
        await cleanupFns.pop()?.();
      }
    },
  };
};
