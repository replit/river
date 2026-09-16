import { describe, expect, test } from 'vitest';
import { Type } from 'typebox';
import {
  Ok,
  Procedure,
  UNEXPECTED_DISCONNECT_CODE,
  createServiceSchema,
} from '../router';
import { createClient } from '../router/client';
import { createServer } from '../router/server';
import { createMockTransportNetwork } from '../testUtil/fixtures/mockTransport';
import { traceLogFn, traceSideOf } from '../testUtil/fixtures/trace';
import {
  advanceFakeTimersByConnectionBackoff,
  cleanupTransports,
  waitFor,
} from '../testUtil/fixtures/cleanup';

/**
 * The "zero-state window": a client that has sent messages the server accepted
 * and DELIVERED TO HANDLERS, but that has received nothing back (no response,
 * no heartbeat -- so its session still reads `nextSentSeq: 0,
 * nextExpectedSeq: 0`), reconnects after the server lost the session (restart
 * or grace expiry). Such a handshake is indistinguishable from a brand-new
 * session by the seq counters alone, so without an explicit reconnect marker
 * the server accepts it as new, the client replays its send buffer, and the
 * handler executes the same request a second time -- while the original call
 * never resolves.
 *
 * This scenario was found by the P model of the protocol
 * (verification/p/README.md, finding 1). The expected behavior asserted here
 * is that of a client that marks reconnection attempts: the server rejects
 * the unknown session with SESSION_STATE_MISMATCH, the client starts a fresh
 * session, and the in-flight call resolves with UNEXPECTED_DISCONNECT --
 * exactly the documented hard-reconnect semantics, and never a duplicate
 * handler execution.
 */
describe('zero-state reconnect to a server that lost the session', () => {
  test('does not re-execute handlers; in-flight calls resolve with UNEXPECTED_DISCONNECT', async () => {
    const invocations: Array<string> = [];

    const ServiceSchema = createServiceSchema();
    const ZeroStateService = ServiceSchema.define({
      work: Procedure.rpc({
        requestInit: Type.Object({ id: Type.String() }),
        responseData: Type.Object({}),
        async handler({ ctx, reqInit }) {
          invocations.push(reqInit.id);
          // hang until abort so nothing (response or ack) ever flows back to
          // the client, keeping the client's session in the zero-state window
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => {
              resolve();
            });
          });

          return Ok({});
        },
      }),
    });
    const services = { svc: ZeroStateService };

    // long heartbeat interval: a server heartbeat would ack the request and
    // take the client out of the zero-state window, masking the scenario
    const quietHeartbeats = {
      heartbeatIntervalMs: 60_000,
      heartbeatsUntilDead: 2,
    };
    const network = createMockTransportNetwork({
      client: {
        ...quietHeartbeats,
        maxJitterMs: 0,
        baseIntervalMs: 10,
        attemptBudgetCapacity: 100,
      },
      server: quietHeartbeats,
    });

    const clientTransport = network.getClientTransport('client');
    const serverTransport = network.getServerTransport('SERVER');
    const violations: Array<string> = [];
    for (const t of [clientTransport, serverTransport]) {
      t.bindLogger(traceLogFn(traceSideOf(t.clientId), violations), 'debug');
    }

    createServer(serverTransport, services);
    const client = createClient<typeof services>(clientTransport, 'SERVER');

    try {
      // the handler runs on the first server, but the client hears nothing
      const pending = client.svc.work.rpc({ id: 'once' });
      await waitFor(() => expect(invocations).toStrictEqual(['once']));

      // the server loses all state; the client's session (and its send
      // buffer holding the request) survives within its grace period
      await network.restartServer();
      const secondServer = network.getServerTransport('SERVER');
      secondServer.bindLogger(traceLogFn('server', violations), 'debug');
      createServer(secondServer, services);

      await advanceFakeTimersByConnectionBackoff();

      // the reconnect must be treated as a hard reconnect, not a fresh
      // session: the caller learns its call died...
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.payload.code).toBe(UNEXPECTED_DISCONNECT_CODE);
      }

      // ...and the handler must never have executed the same request twice
      expect(invocations).toStrictEqual(['once']);

      // the fresh session works: new calls reach the new server
      const again = client.svc.work.rpc({ id: 'later' });
      await waitFor(() => expect(invocations).toStrictEqual(['once', 'later']));
      clientTransport.hardDisconnect();
      await again;

      expect(violations).toStrictEqual([]);
    } finally {
      await cleanupTransports([clientTransport, serverTransport]);
      await network.cleanup();
    }
  });
});
