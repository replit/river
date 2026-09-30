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
import type { LogFn } from '../logging';
import {
  advanceFakeTimersByConnectionBackoff,
  cleanupTransports,
  waitFor,
} from '../testUtil/fixtures/cleanup';

/**
 * A client that sent a request but never heard back still has zeroed seq
 * counters. If the server loses the session, the reconnect must be rejected
 * (hard reconnect) rather than accepted as new, or the replayed request runs
 * the handler twice.
 */
function collectViolations(violations: Array<string>): LogFn {
  return (msg, ctx, level) => {
    if (ctx?.tags?.includes('invariant-violation')) {
      violations.push(`[${level}] ${msg}`);
    }
  };
}

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
      t.bindLogger(collectViolations(violations), 'debug');
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
      secondServer.bindLogger(collectViolations(violations), 'debug');
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
