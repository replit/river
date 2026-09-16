import { describe, expect, test } from 'vitest';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { Type } from 'typebox';
import { Ok, Procedure, createServiceSchema } from '../../router';
import { createClient } from '../../router/client';
import { createServer } from '../../router/server';
import {
  ReadableBrokenError,
  ReadableImpl,
  WritableImpl,
} from '../../router/streams';
import { createMockTransportNetwork } from '../../testUtil/fixtures/mockTransport';
import { traceLogFn, traceSideOf } from '../../testUtil/fixtures/trace';
import { cleanupTransports } from '../../testUtil/fixtures/cleanup';
import type {
  ProvidedClientTransportOptions,
  ProvidedServerTransportOptions,
} from '../../transport/options';

/**
 * Reader/writer semantics from PROTOCOL.md: ordering, half-close, teardown.
 * See ./README.md for the catalog.
 */

// each case stands up a whole transport network, so fewer cases than the pure
// properties below
const TRANSPORT_CASES = { testCases: 20 };
const TRANSPORT_TIMEOUT_MS = 60_000;

const ServiceSchema = createServiceSchema();

const PropertyService = ServiceSchema.define({
  /** Echoes every request value straight back. */
  echo: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: Type.Object({ value: Type.Number() }),
    responseData: Type.Object({ value: Type.Number() }),
    async handler({ reqReadable, resWritable }) {
      for await (const msg of reqReadable) {
        if (!msg.ok) break;
        resWritable.write(Ok({ value: msg.payload.value }));
      }

      resWritable.close();
    },
  }),
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
  /** Writes a fixed list of values, then closes. */
  emit: Procedure.subscription({
    requestInit: Type.Object({ values: Type.Array(Type.Number()) }),
    responseData: Type.Object({ value: Type.Number() }),
    async handler({ reqInit, resWritable }) {
      for (const value of reqInit.values) {
        resWritable.write(Ok({ value }));
      }

      resWritable.close();
    },
  }),
  /** Drains the request side first, so its writes provably happen half-closed. */
  drainThenEmit: Procedure.stream({
    requestInit: Type.Object({ after: Type.Array(Type.Number()) }),
    requestData: Type.Object({ value: Type.Number() }),
    responseData: Type.Object({ value: Type.Number() }),
    async handler({ reqInit, reqReadable, resWritable }) {
      for await (const msg of reqReadable) {
        if (!msg.ok) break;
      }

      // the client has closed its writer; ours is still open
      for (const value of reqInit.after) {
        resWritable.write(Ok({ value }));
      }

      resWritable.close();
    },
  }),
});

const services = { svc: PropertyService };

const values = gs.integers({ minValue: -1_000, maxValue: 1_000 });
const valueLists = gs.arrays(values, { maxSize: 12 });

/**
 * A fresh in-memory client/server pair per generated case.
 *
 * Collects `invariant-violation` logs -- the transport's own ordering
 * self-checks -- and asserts none fired, so every property here carries C4.
 */
async function withNetwork(
  run: (ctx: {
    client: ReturnType<typeof createClient<typeof services>>;
  }) => Promise<void>,
  opts?: {
    client?: ProvidedClientTransportOptions;
    server?: ProvidedServerTransportOptions;
  },
) {
  const network = createMockTransportNetwork(opts);
  const clientTransport = network.getClientTransport('client');
  const serverTransport = network.getServerTransport('SERVER');

  const violations: Array<string> = [];
  for (const t of [clientTransport, serverTransport]) {
    t.bindLogger(traceLogFn(traceSideOf(t.clientId), violations), 'debug');
  }

  createServer(serverTransport, services);
  const client = createClient<typeof services>(clientTransport, 'SERVER');

  try {
    await run({ client });
    expect(violations).toStrictEqual([]);
  } finally {
    await cleanupTransports([clientTransport, serverTransport]);
    await network.cleanup();
  }
}

describe('stream lifecycle properties', () => {
  test(
    'B1: upload delivers exactly the values written, in write order',
    () =>
      hegel.testAsync(async (tc) => {
        const sent = tc.draw(valueLists);
        tc.note(`sending ${sent.length} values`);

        await withNetwork(async ({ client }) => {
          const { reqWritable, finalize } = client.svc.collect.upload({});
          for (const value of sent) {
            reqWritable.write({ value });
          }

          reqWritable.close();

          const result = await finalize();
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          expect(result.payload.values).toStrictEqual(sent);
        });
      }, TRANSPORT_CASES),
    TRANSPORT_TIMEOUT_MS,
  );

  test(
    'B2: stream echoes every value back in send order',
    () =>
      hegel.testAsync(async (tc) => {
        const sent = tc.draw(valueLists);
        tc.note(`sending ${sent.length} values`);

        await withNetwork(async ({ client }) => {
          const { reqWritable, resReadable } = client.svc.echo.stream({});
          for (const value of sent) {
            reqWritable.write({ value });
          }

          reqWritable.close();

          const received = await resReadable.collect();
          expect(
            received.map((r) => (r.ok ? r.payload.value : r)),
          ).toStrictEqual(sent);
        });
      }, TRANSPORT_CASES),
    TRANSPORT_TIMEOUT_MS,
  );

  test(
    'B3: subscription delivers exactly the values the server wrote, in order',
    () =>
      hegel.testAsync(async (tc) => {
        const emitted = tc.draw(valueLists);
        tc.note(`emitting ${emitted.length} values`);

        await withNetwork(async ({ client }) => {
          const { resReadable } = client.svc.emit.subscribe({
            values: emitted,
          });

          const received = await resReadable.collect();
          expect(
            received.map((r) => (r.ok ? r.payload.value : r)),
          ).toStrictEqual(emitted);
        });
      }, TRANSPORT_CASES),
    TRANSPORT_TIMEOUT_MS,
  );

  test(
    'B4: after the client half-closes, the server can still write and the client still reads',
    () =>
      hegel.testAsync(async (tc) => {
        const sent = tc.draw(valueLists);
        const after = tc.draw(gs.arrays(values, { minSize: 1, maxSize: 8 }));
        tc.note(
          `${sent.length} up, then ${after.length} down after half-close`,
        );

        await withNetwork(async ({ client }) => {
          const { reqWritable, resReadable } = client.svc.drainThenEmit.stream({
            after,
          });

          for (const value of sent) {
            reqWritable.write({ value });
          }

          // half-close: our writer is done, the server's is not
          reqWritable.close();
          expect(reqWritable.isWritable()).toBe(false);

          const received = await resReadable.collect();
          expect(
            received.map((r) => (r.ok ? r.payload.value : r)),
          ).toStrictEqual(after);
        });
      }, TRANSPORT_CASES),
    TRANSPORT_TIMEOUT_MS,
  );

  test(
    'B8: backpressure is advisory -- ignoring it still delivers every value in order',
    () =>
      hegel.testAsync(async (tc) => {
        // enough values to overrun a high-water mark of 1 many times over
        const sent = tc.draw(gs.arrays(values, { minSize: 8, maxSize: 16 }));

        let sawBackpressure = false;
        await withNetwork(
          async ({ client }) => {
            const { reqWritable, finalize } = client.svc.collect.upload({});

            // deliberately ignore the signal: the contract is that the value is
            // still buffered and delivered, like node's stream.Writable.write
            for (const value of sent) {
              if (!reqWritable.write({ value })) {
                sawBackpressure = true;
              }
            }

            reqWritable.close();

            const result = await finalize();
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            // not one value dropped, not one reordered
            expect(result.payload.values).toStrictEqual(sent);
          },
          { client: { sendBufferHighWaterMark: 1 } },
        );

        // the scenario is only meaningful if pressure was reported
        expect(sawBackpressure).toBe(true);
      }, TRANSPORT_CASES),
    TRANSPORT_TIMEOUT_MS,
  );
});

/** No transport in the way, so these can afford hegel's full case count. */
describe('reader and writer contract properties', () => {
  test('B6: a Writable accepts writes until close, then refuses them', () =>
    hegel.testAsync((tc) => {
      const before = tc.draw(gs.arrays(values, { maxSize: 8 }));
      const closeWithValue = tc.draw(gs.optional(values));

      const written: Array<number> = [];
      let closeCalls = 0;
      const writable = new WritableImpl<number>({
        writeCb: (v) => written.push(v),
        closeCb: () => {
          closeCalls++;
        },
      });

      for (const value of before) {
        expect(writable.isWritable()).toBe(true);
        writable.write(value);
      }

      writable.close(closeWithValue ?? undefined);

      // close(value) delivers the value as the final write (property B5)
      const expected =
        closeWithValue === null ? before : [...before, closeWithValue];
      expect(written).toStrictEqual(expected);

      expect(writable.isWritable()).toBe(false);
      expect(() => writable.write(0)).toThrow(/closed Writable/);

      // close is idempotent -- repeated calls neither write nor re-notify
      const extraCloses = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
      for (let i = 0; i < extraCloses; i++) {
        writable.close();
      }

      expect(closeCalls).toBe(1);
      expect(written).toStrictEqual(expected);
    }));

  test('B7: a Readable yields every pushed value once, in push order', () =>
    hegel.testAsync(async (tc) => {
      const pushed = tc.draw(gs.arrays(values, { maxSize: 12 }));

      const readable = new ReadableImpl<number, never>();
      for (const value of pushed) {
        readable._pushValue(Ok(value));
      }

      readable._triggerClose();

      expect(readable.isReadable()).toBe(true);
      const collected = await readable.collect();
      expect(collected.map((r) => (r.ok ? r.payload : r))).toStrictEqual(
        pushed,
      );

      // consuming locks the Readable for the rest of its life
      expect(readable.isReadable()).toBe(false);
    }));

  test('B8: write() reports the advisory signal, and closing releases the waiter', () =>
    hegel.testAsync(async (tc) => {
      const pressured = tc.draw(gs.booleans());

      const writable = new WritableImpl<number>({
        writeCb: () => undefined,
        closeCb: () => undefined,
        backpressure: {
          isSendBufferFull: () => pressured,
          // while pressured and open a waiter really does hang; never awaited
          // before close
          waitForSendBufferDrain: () =>
            pressured ? new Promise<void>(() => undefined) : Promise.resolve(),
        },
      });

      // surfaces pressure verbatim, and accepts the value either way
      expect(writable.write(tc.draw(values))).toBe(!pressured);

      // a closed writable must never strand a caller
      writable.close();
      await expect(writable.waitForWriteReady()).resolves.toBeUndefined();
    }));

  test('B7: break() resolves a pending read with READABLE_BROKEN', () =>
    hegel.testAsync(async (tc) => {
      const pushed = tc.draw(gs.arrays(values, { maxSize: 6 }));

      const readable = new ReadableImpl<number, never>();
      for (const value of pushed) {
        readable._pushValue(Ok(value));
      }

      const iterator = readable[Symbol.asyncIterator]();

      // drain what was queued, checking order on the way through
      for (const expected of pushed) {
        const next = await iterator.next();
        expect(next.done).toBe(false);
        if (next.done) return;

        expect(next.value.ok ? next.value.payload : next.value).toBe(expected);
      }

      // now there is a reader waiting with nothing to read
      const pending = iterator.next();
      readable.break();

      const result = await pending;
      expect(result.done).toBe(false);
      if (result.done) return;

      expect(result.value.ok).toBe(false);
      if (result.value.ok) return;

      expect(result.value.payload).toStrictEqual(ReadableBrokenError);
      expect(readable.isReadable()).toBe(false);
    }));
});
