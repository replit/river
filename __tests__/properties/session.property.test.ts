import { describe, expect, test, vi } from 'vitest';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { Type, type Static } from 'typebox';
import {
  type MaybeDisposable,
  Ok,
  Procedure,
  UNEXPECTED_DISCONNECT_CODE,
  createServiceSchema,
} from '../../router';
import {
  createClientHandshakeOptions,
  createServerHandshakeOptions,
} from '../../router/handshake';
import { createClient } from '../../router/client';
import { createServer } from '../../router/server';
import { closeAllConnections, numberOfConnections } from '../../testUtil';
import { createMockTransportNetwork } from '../../testUtil/fixtures/mockTransport';
import type { TestTransportOptions } from '../../testUtil/fixtures/transports';
import {
  advanceFakeTimersByConnectionBackoff,
  advanceFakeTimersBySessionGrace,
  cleanupTransports,
  waitFor,
} from '../../testUtil/fixtures/cleanup';

/**
 * Delivery guarantees under generated fault schedules. See ./README.md.
 *
 * C2 (seq/ack discipline) and C3 (send-buffer trimming) are not asserted
 * against session internals: the transport already self-checks both and logs an
 * `invariant-violation` when they break. Every property here asserts no such log
 * fired, which makes C4 the oracle for all three.
 */

const FAULT_CASES = { testCases: 15 };
const FAULT_TIMEOUT_MS = 120_000;

/**
 * Reconnect policy for these properties, which are about delivery rather than
 * about the reconnect policy itself (`transport/rateLimit.test.ts` covers that).
 *
 * The budget defaults to 5 attempts, so a 5-disconnect schedule legitimately
 * exhausts it and the client stops redialing -- correct, but it would silently
 * turn a delivery property into a rate-limiter property. Backoff jitter is
 * `Math.random()`, which makes a failing case unreplayable; zeroing it is what
 * lets hegel shrink these reliably.
 */
const deterministicReconnects = {
  attemptBudgetCapacity: 100,
  maxJitterMs: 0,
  baseIntervalMs: 10,
  maxBackoffMs: 100,
};

const ServiceSchema = createServiceSchema();

const PropertyService = ServiceSchema.define({
  /** Accumulates every request value and reports them in one response. */
  collect: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({ value: Type.Number() }),
    responseData: Type.Object({ values: Type.Array(Type.Number()) }),
    async handler({ reqReadable }) {
      const values: Array<number> = [];
      for await (const msg of reqReadable) {
        if (!msg.ok) break;
        values.push(msg.payload.value);
      }

      return Ok({ values });
    },
  }),
  /** Never returns on its own -- used to have something in flight during a fault. */
  hang: Procedure.rpc({
    requestInit: Type.Object({}),
    responseData: Type.Object({}),
    async handler({ ctx }) {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          resolve();
        });
      });

      return Ok({});
    },
  }),
});

const services = { svc: PropertyService };

const values = gs.integers({ minValue: -1_000, maxValue: 1_000 });

/**
 * A generated schedule of writes with disconnects interleaved between them.
 * `null` means "drop the connection here"; a number means "write this value".
 */
const writeSchedules = gs.arrays(gs.optional(values), {
  minSize: 1,
  maxSize: 14,
});

interface MultiplexedSchedule {
  /** The values each concurrent stream is expected to deliver, in order. */
  perStream: Array<Array<number>>;
  /** A generated interleaving of those writes across the streams. */
  writes: Array<{ stream: number; value: number }>;
  /** Indices into `writes` before which the connection is dropped. */
  faultAt: Set<number>;
}

/** Built in two passes -- interleave, then insert faults -- so it terminates. */
const multiplexedSchedules: gs.Generator<MultiplexedSchedule> = gs.composite(
  (tc) => {
    const streamCount = tc.draw(gs.integers({ minValue: 2, maxValue: 4 }));
    const perStream: Array<Array<number>> = [];
    for (let i = 0; i < streamCount; i++) {
      perStream.push(tc.draw(gs.arrays(values, { maxSize: 6 })));
    }

    // a cursor per stream, picking which advances next: a real interleaving
    // rather than a fixed round-robin
    const cursors = perStream.map(() => 0);
    const writes: Array<{ stream: number; value: number }> = [];
    let outstanding = perStream.reduce((n, stream) => n + stream.length, 0);
    while (outstanding > 0) {
      const ready = perStream
        .map((_, index) => index)
        .filter((index) => cursors[index] < perStream[index].length);
      const stream =
        ready[
          tc.draw(gs.integers({ minValue: 0, maxValue: ready.length - 1 }))
        ];

      writes.push({ stream, value: perStream[stream][cursors[stream]] });
      cursors[stream]++;
      outstanding--;
    }

    const faultAt = new Set<number>();
    const faultCount = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
    for (let i = 0; i < faultCount; i++) {
      faultAt.add(
        tc.draw(gs.integers({ minValue: 0, maxValue: writes.length })),
      );
    }

    return { perStream, writes, faultAt };
  },
);

function setup(opts?: TestTransportOptions): {
  network: ReturnType<typeof createMockTransportNetwork>;
  clientTransport: ReturnType<
    ReturnType<typeof createMockTransportNetwork>['getClientTransport']
  >;
  serverTransport: ReturnType<
    ReturnType<typeof createMockTransportNetwork>['getServerTransport']
  >;
  client: ReturnType<typeof createClient<typeof services>>;
  violations: Array<string>;
} {
  const network = createMockTransportNetwork({
    ...opts,
    client: { ...deterministicReconnects, ...opts?.client },
  });
  const clientTransport = network.getClientTransport('client');
  const serverTransport = network.getServerTransport('SERVER');

  const violations: Array<string> = [];
  for (const t of [clientTransport, serverTransport]) {
    t.bindLogger((msg, ctx, level) => {
      if (ctx?.tags?.includes('invariant-violation')) {
        violations.push(`[${level}] ${msg}`);
      }
    }, 'debug');
  }

  createServer(serverTransport, services);
  const client = createClient<typeof services>(clientTransport, 'SERVER');

  return { network, clientTransport, serverTransport, client, violations };
}

async function teardown(ctx: ReturnType<typeof setup>) {
  await cleanupTransports([ctx.clientTransport, ctx.serverTransport]);
  await ctx.network.cleanup();
}

describe('session properties under faults', () => {
  test(
    'C1/C4: transparent reconnects preserve exactly-once, in-order delivery',
    () =>
      hegel.testAsync(async (tc) => {
        const schedule = tc.draw(writeSchedules);
        const sent = schedule.filter((step): step is number => step !== null);
        const disconnects = schedule.length - sent.length;
        tc.note(
          `${sent.length} writes, ${disconnects} disconnects interleaved`,
        );

        const ctx = setup();
        try {
          const { reqWritable, finalize } = ctx.client.svc.collect.upload({});

          for (const step of schedule) {
            if (step === null) {
              // the session survives the wire, so the client should reconnect
              // and resend whatever was not acked
              closeAllConnections(ctx.clientTransport);
              continue;
            }

            reqWritable.write({ value: step });
          }

          reqWritable.close();

          const result = await finalize();
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // nothing dropped, nothing duplicated, nothing reordered
          expect(result.payload.values).toStrictEqual(sent);
          expect(ctx.violations).toStrictEqual([]);
        } finally {
          await teardown(ctx);
        }
      }, FAULT_CASES),
    FAULT_TIMEOUT_MS,
  );

  test(
    'C6: a transparent reconnect keeps the session id',
    () =>
      hegel.testAsync(async (tc) => {
        const drops = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
        tc.note(`${drops} consecutive reconnects`);

        const ctx = setup();
        try {
          // establish a session
          const { reqWritable, finalize } = ctx.client.svc.collect.upload({});
          reqWritable.write({ value: 1 });

          await waitFor(() =>
            expect(numberOfConnections(ctx.clientTransport)).toBe(1),
          );
          const originalId = ctx.clientTransport.sessions.get('SERVER')?.id;
          expect(originalId).toBeDefined();

          for (let i = 0; i < drops; i++) {
            closeAllConnections(ctx.clientTransport);

            // backoff grows with each consecutive failure; skip it, don't race it
            await advanceFakeTimersByConnectionBackoff();
            await waitFor(() =>
              expect(numberOfConnections(ctx.clientTransport)).toBe(1),
            );

            // the session outlives the connection, so its identity must not change
            expect(ctx.clientTransport.sessions.get('SERVER')?.id).toBe(
              originalId,
            );
          }

          reqWritable.close();
          await finalize();

          expect(ctx.violations).toStrictEqual([]);
        } finally {
          await teardown(ctx);
        }
      }, FAULT_CASES),
    FAULT_TIMEOUT_MS,
  );

  test(
    'C5: a hard reconnect resolves in-flight calls with UNEXPECTED_DISCONNECT',
    () =>
      hegel.testAsync(async (tc) => {
        const inFlight = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
        tc.note(`${inFlight} calls in flight when the server restarts`);

        const ctx = setup();
        try {
          const pending = Array.from({ length: inFlight }, () =>
            ctx.client.svc.hang.rpc({}),
          );

          await waitFor(() =>
            expect(numberOfConnections(ctx.clientTransport)).toBe(1),
          );

          // hard reconnect: every waiting caller must get a result, not hang
          await ctx.network.restartServer();

          // jump the sessionDisconnectGraceMs wait rather than sleeping it
          await advanceFakeTimersBySessionGrace();

          const results = await Promise.all(pending);
          for (const result of results) {
            expect(result.ok).toBe(false);
            if (result.ok) continue;

            expect(result.payload.code).toBe(UNEXPECTED_DISCONNECT_CODE);
          }

          expect(ctx.violations).toStrictEqual([]);
        } finally {
          await teardown(ctx);
        }
      }, FAULT_CASES),
    FAULT_TIMEOUT_MS,
  );

  test(
    'C7: any fault schedule still tears down to zero sessions and connections',
    () =>
      hegel.testAsync(async (tc) => {
        const schedule = tc.draw(writeSchedules);
        tc.note(`${schedule.length} steps`);

        const ctx = setup();
        try {
          const { reqWritable, finalize } = ctx.client.svc.collect.upload({});
          for (const step of schedule) {
            if (step === null) {
              closeAllConnections(ctx.clientTransport);
              continue;
            }

            reqWritable.write({ value: step });
          }

          reqWritable.close();
          await finalize();
        } finally {
          await teardown(ctx);
        }

        // closing a transport must drop everything it owned, whatever happened
        // to the wire along the way
        for (const t of [ctx.clientTransport, ctx.serverTransport]) {
          await waitFor(() => expect(numberOfConnections(t)).toBe(0));
        }

        expect(ctx.violations).toStrictEqual([]);
      }, FAULT_CASES),
    FAULT_TIMEOUT_MS,
  );

  test(
    'C8: concurrent streams on one session never mix up their values across faults',
    () =>
      hegel.testAsync(async (tc) => {
        const { perStream, writes, faultAt } = tc.draw(multiplexedSchedules);
        tc.note(
          `${perStream.length} streams, ${writes.length} writes, ${faultAt.size} disconnects`,
        );

        const ctx = setup();
        try {
          // one session, so streamId routing is all that keeps them apart
          const calls = perStream.map(() => ctx.client.svc.collect.upload({}));

          for (let i = 0; i < writes.length; i++) {
            if (faultAt.has(i)) {
              closeAllConnections(ctx.clientTransport);
            }

            const { stream, value } = writes[i];
            calls[stream].reqWritable.write({ value });
          }

          if (faultAt.has(writes.length)) {
            closeAllConnections(ctx.clientTransport);
          }

          for (const call of calls) {
            call.reqWritable.close();
          }

          const results = await Promise.all(calls.map((c) => c.finalize()));

          for (let i = 0; i < results.length; i++) {
            const result = results[i];
            expect(result.ok).toBe(true);
            if (!result.ok) continue;

            // its own values, its own order, nothing belonging to a sibling
            expect(result.payload.values).toStrictEqual(perStream[i]);
          }

          expect(ctx.violations).toStrictEqual([]);
        } finally {
          await teardown(ctx);
        }
      }, FAULT_CASES),
    FAULT_TIMEOUT_MS,
  );
});

/**
 * The watchdog (#395) measures elapsed time since the last inbound message
 * rather than counting heartbeats sent. Both directions of that: it must not
 * fire while traffic arrives, and must fire once traffic stops.
 */
describe('heartbeat watchdog properties', () => {
  const heartbeatIntervals = gs.sampledFrom([250, 500, 1_000]);
  const heartbeatsUntilDead = gs.integers({ minValue: 2, maxValue: 4 });

  test(
    'C9a: a connection with a live peer survives arbitrarily long',
    () =>
      hegel.testAsync(async (tc) => {
        const heartbeatIntervalMs = tc.draw(heartbeatIntervals);
        const misses = tc.draw(heartbeatsUntilDead);
        // well past the deadline, several times over
        const rounds = tc.draw(gs.integers({ minValue: 2, maxValue: 5 }));
        tc.note(
          `${heartbeatIntervalMs}ms x ${misses} misses, idling ${rounds} deadlines`,
        );

        const opts = {
          heartbeatIntervalMs,
          heartbeatsUntilDead: misses,
        };
        const ctx = setup({ client: opts, server: opts });
        try {
          const { reqWritable, finalize } = ctx.client.svc.collect.upload({});
          reqWritable.write({ value: 1 });

          await waitFor(() =>
            expect(numberOfConnections(ctx.clientTransport)).toBe(1),
          );
          const sessionId = ctx.clientTransport.sessions.get('SERVER')?.id;

          // the peer heartbeats throughout, so elapsed time alone must never
          // read as a missed heartbeat
          await vi.advanceTimersByTimeAsync(
            rounds * misses * heartbeatIntervalMs,
          );

          expect(numberOfConnections(ctx.clientTransport)).toBe(1);
          expect(ctx.clientTransport.sessions.get('SERVER')?.id).toBe(
            sessionId,
          );

          // and the stream that was open the whole time still works
          reqWritable.write({ value: 2 });
          reqWritable.close();

          const result = await finalize();
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          expect(result.payload.values).toStrictEqual([1, 2]);
          expect(ctx.violations).toStrictEqual([]);
        } finally {
          await teardown(ctx);
        }
      }, FAULT_CASES),
    FAULT_TIMEOUT_MS,
  );

  test(
    'C9b: a silent peer is detected within heartbeatsUntilDead * heartbeatIntervalMs',
    () =>
      hegel.testAsync(async (tc) => {
        const heartbeatIntervalMs = tc.draw(heartbeatIntervals);
        const misses = tc.draw(heartbeatsUntilDead);
        tc.note(`deadline is ${misses * heartbeatIntervalMs}ms`);

        const opts = {
          heartbeatIntervalMs,
          heartbeatsUntilDead: misses,
        };
        const ctx = setup({ client: opts, server: opts });
        try {
          // sit on the dead connection, so we observe the watchdog and not a
          // reconnect race
          ctx.clientTransport.reconnectOnConnectionDrop = false;

          const { reqWritable } = ctx.client.svc.collect.upload({});
          reqWritable.write({ value: 1 });

          await waitFor(() =>
            expect(numberOfConnections(ctx.clientTransport)).toBe(1),
          );

          // the wire goes quiet without either side being told
          ctx.network.simulatePhantomDisconnect();

          // past the deadline, allowing for tick granularity and for however
          // long ago the last inbound message was
          await vi.advanceTimersByTimeAsync((misses + 2) * heartbeatIntervalMs);

          await waitFor(() =>
            expect(numberOfConnections(ctx.clientTransport)).toBe(0),
          );

          expect(ctx.violations).toStrictEqual([]);
        } finally {
          await teardown(ctx);
        }
      }, FAULT_CASES),
    FAULT_TIMEOUT_MS,
  );
});

/**
 * `__tests__/e2e.test.ts` covers re-handshaking on a quiet connection. This
 * crosses it with faults, because the two interact: a transparent reconnect is
 * itself a fresh handshake, re-running `construct` and `validate`.
 *
 * The invariant is convergence -- whatever `construct` would return right now,
 * the server's metadata must catch up to it after any step, refresh or reconnect.
 */
describe('re-handshake under faults', () => {
  /**
   * Advances fake time until `predicate` holds.
   *
   * Reconnect backoff grows with each attempt and carries random jitter, so
   * polling wall-clock time makes this genuinely nondeterministic. This still
   * fails if convergence never happens, it just doesn't care how many backoff
   * windows it took.
   */
  async function settleUntil(predicate: () => boolean, what: string) {
    for (let slice = 0; slice < 200; slice++) {
      if (predicate()) return;
      await vi.advanceTimersByTimeAsync(50);
    }

    throw new Error(`timed out waiting for ${what}`);
  }

  const isConnected = (
    transport: ReturnType<
      ReturnType<typeof createMockTransportNetwork>['getClientTransport']
    >,
  ) => numberOfConnections(transport) === 1;

  const handshakeSchema = Type.Object({ token: Type.String() });

  type HandshakeMetadata = Static<typeof handshakeSchema>;

  const MetadataServiceSchema = createServiceSchema<
    MaybeDisposable,
    HandshakeMetadata
  >();

  const metadataServices = {
    svc: MetadataServiceSchema.define({
      getToken: Procedure.rpc({
        requestInit: Type.Object({}),
        responseData: Type.Object({ token: Type.String() }),
        handler: async ({ ctx }) => Ok({ token: ctx.metadata.token }),
      }),
    }),
  };

  const steps = gs.arrays(gs.sampledFrom(['reconnect', 'refresh'] as const), {
    minSize: 1,
    maxSize: 6,
  });

  test(
    'C10: metadata converges on the current credential after any mix of refreshes and reconnects',
    () =>
      hegel.testAsync(async (tc) => {
        const schedule = tc.draw(steps);
        tc.note(schedule.join(' -> '));

        let token = 'token-0';
        const network = createMockTransportNetwork({
          client: deterministicReconnects,
        });
        const clientTransport = network.getClientTransport(
          'client',
          createClientHandshakeOptions(handshakeSchema, () => ({ token })),
        );
        const serverTransport = network.getServerTransport<
          typeof handshakeSchema,
          HandshakeMetadata
        >(
          'SERVER',
          createServerHandshakeOptions<
            typeof handshakeSchema,
            HandshakeMetadata
          >(handshakeSchema, (metadata) => ({ token: metadata.token })),
        );

        const violations: Array<string> = [];
        for (const t of [clientTransport, serverTransport]) {
          t.bindLogger((msg, ctx, level) => {
            if (ctx?.tags?.includes('invariant-violation')) {
              violations.push(`[${level}] ${msg}`);
            }
          }, 'debug');
        }

        createServer(serverTransport, metadataServices);
        const client = createClient<typeof metadataServices>(
          clientTransport,
          'SERVER',
        );

        try {
          // establish the session with the initial credential
          const first = await client.svc.getToken.rpc({});
          expect(first).toStrictEqual({ ok: true, payload: { token } });

          const sessionId = clientTransport.sessions.get('SERVER')?.id;
          expect(sessionId).toBeDefined();

          for (let i = 0; i < schedule.length; i++) {
            // the credential rotates underneath both paths
            token = `token-${i + 1}`;

            if (schedule[i] === 'reconnect') {
              closeAllConnections(clientTransport);
            } else {
              await settleUntil(
                () => isConnected(clientTransport),
                'a connection to re-handshake over',
              );
              expect(serverTransport.requestRehandshake('client')).toBe(true);
            }

            await settleUntil(
              () => isConnected(clientTransport),
              'the connection to come back',
            );

            // either way the server must end up holding the current credential
            await settleUntil(
              () =>
                serverTransport.sessionHandshakeMetadata.get('client')
                  ?.token === token,
              `metadata to converge on ${token}`,
            );

            // and none of this is allowed to be a hard reconnect
            expect(clientTransport.sessions.get('SERVER')?.id).toBe(sessionId);
          }

          // ctx.metadata is live, so a handler run now sees the latest value
          const last = await client.svc.getToken.rpc({});
          expect(last).toStrictEqual({ ok: true, payload: { token } });

          expect(violations).toStrictEqual([]);
        } finally {
          await cleanupTransports([clientTransport, serverTransport]);
          await network.cleanup();
        }
      }, FAULT_CASES),
    FAULT_TIMEOUT_MS,
  );
});
