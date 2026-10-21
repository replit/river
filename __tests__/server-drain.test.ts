import { afterEach, expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import {
  createClient,
  createServer,
  createServiceSchema,
  Middleware,
  Ok,
  Procedure,
} from '../router';
import { createMockTransportNetwork, readNextResult } from '../testUtil';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { createPromiseWithResolvers } from '../transport/promises';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(middlewares: Array<Middleware> = []) {
  const network = createMockTransportNetwork();
  const gate = createPromiseWithResolvers<void>();
  const effects: Array<string> = [];
  const services = {
    test: createServiceSchema().define({
      hold: Procedure.rpc({
        requestInit: Type.Object({}),
        responseData: Type.Null(),
        async handler() {
          effects.push('hold');
          await gate.promise;

          return Ok(null);
        },
      }),
      rpc: Procedure.rpc({
        requestInit: Type.Object({}),
        responseData: Type.Null(),
        async handler() {
          effects.push('rpc');

          return Ok(null);
        },
      }),
      subscription: Procedure.subscription({
        requestInit: Type.Object({}),
        responseData: Type.Null(),
        async handler({ resWritable }) {
          resWritable.write(Ok(null));
        },
      }),
    }),
  };
  const transport = network.getServerTransport();
  const clientTransport = network.getClientTransport('client');
  const server = createServer(transport, services, { middlewares });
  const client = createClient<typeof services>(clientTransport, 'SERVER');
  cleanups.push(async () => {
    gate.resolve();
    clientTransport.close();
    transport.close();
    await server.close();
    await network.cleanup();
  });

  return { server, transport, clientTransport, client, gate, effects };
}

test('drain refuses calls before middleware or handler runs', async () => {
  // Risk: a refused call that ran would be unsafe to resend.
  const effects: Array<string> = [];
  const f = setup([
    ({ next }) => {
      effects.push('middleware');
      next();
    },
  ]);
  void f.client.test.hold.rpc({});
  await waitFor(() => expect(f.effects).toContain('hold'));
  effects.length = 0;
  void f.server.drain({ budgetMs: 1000 });
  expect(await f.client.test.rpc.rpc({})).toMatchObject({
    ok: false,
    payload: { code: 'SERVER_DRAINING' },
  });
  expect(effects).toEqual([]);
  expect(f.effects).toEqual(['hold']);
});

test('drain inside middleware waits for its admitted rpc result', async () => {
  // Risk: an accepted call is closed as if the server were idle.
  const f = setup([
    ({ next }) => {
      void f.server.drain({ budgetMs: 1000 });
      next();
    },
  ]);
  const result = f.client.test.hold.rpc({});
  await waitFor(() => expect(f.effects).toContain('hold'));
  expect(f.transport.getStatus()).not.toBe('closed');
  f.gate.resolve();
  expect(await result).toEqual(Ok(null));
  await f.server.drain({ budgetMs: 1000 });
  expect(f.transport.getStatus()).toBe('closed');
});

test('an open subscription does not hold drain or preserve the old session', async () => {
  // Risk: long streams keep clients on the old server for the whole budget.
  const f = setup();
  const subscription = f.client.test.subscription.subscribe({});
  expect(await readNextResult(subscription.resReadable)).toEqual(Ok(null));
  const result = f.client.test.hold.rpc({});
  await waitFor(() => expect(f.effects).toContain('hold'));
  const draining = f.server.drain({ budgetMs: 1000 });
  expect(f.transport.getStatus()).not.toBe('closed');
  f.gate.resolve();
  expect(await result).toEqual(Ok(null));
  expect(f.transport.getStatus()).toBe('closed');
  await draining;
  expect(f.transport.getStatus()).toBe('closed');
  expect(f.transport.sessions.size).toBe(0);
  expect(f.server.streams.size).toBe(0);
});

test('the drain budget closes a server whose rpc never returns', async () => {
  // Risk: shutdown hangs.
  const f = setup();
  void f.client.test.hold.rpc({});
  await waitFor(() => expect(f.effects).toContain('hold'));
  const draining = f.server.drain({ budgetMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  expect(f.transport.getStatus()).toBe('closed');
  await draining;
});
