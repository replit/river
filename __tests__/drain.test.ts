import { afterEach, expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import {
  ClientOptions,
  createClient,
  createServer,
  createServiceSchema,
  Err,
  Middleware,
  Ok,
  Procedure,
  UNCAUGHT_ERROR_CODE,
} from '../router';
import { createMockTransportNetwork, readNextResult } from '../testUtil';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { createPromiseWithResolvers } from '../transport/promises';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(
  maxResends?: number,
  newSessionWaitMs = 1000,
  middlewares: Array<Middleware> = [],
) {
  const network = createMockTransportNetwork({
    client: { baseIntervalMs: 1, maxJitterMs: 0 },
  });
  const gate = createPromiseWithResolvers<void>();
  const uploadGate = createPromiseWithResolvers<void>();
  const effects: Array<string> = [];
  const attempts: Array<string | undefined> = [];
  const init = Type.Object({});
  const responseData = Type.Null();
  const services = {
    test: createServiceSchema().define({
      rpc: Procedure.rpc({
        requestInit: Type.Boolean(),
        responseData,
        async handler({ reqInit }) {
          effects.push(reqInit ? 'hold' : 'rpc');
          if (reqInit) await gate.promise;

          return Ok(null);
        },
      }),
      upload: Procedure.upload({
        requestInit: init,
        requestData: Type.Null(),
        responseData,
        async handler() {
          effects.push('upload');
          await uploadGate.promise;

          return Ok(null);
        },
      }),
      subscription: Procedure.subscription({
        requestInit: init,
        responseData,
        async handler({ resWritable }) {
          resWritable.write(Ok(null));
        },
      }),
      claim: Procedure.rpc({
        requestInit: init,
        responseData,
        responseError: Type.Object({
          code: Type.Literal('SERVER_DRAINING'),
          message: Type.String(),
        }),
        async handler() {
          effects.push('claim');

          return Err({ code: 'SERVER_DRAINING', message: 'upstream' });
        },
      }),
    }),
  };
  function startServer() {
    const transport = network.getServerTransport();
    const server = createServer(transport, services, { middlewares });
    transport.addEventListener('message', (message) => {
      if (message.procedureName === 'rpc' && message.payload === false)
        attempts.push(transport.sessions.get(message.from)?.id);
    });
    cleanups.push(async () => {
      transport.close();
      await server.close();
    });

    return { server, transport };
  }
  cleanups.push(() => network.cleanup());
  const blocker = network.getClientTransport('blocker');
  const clientTransport = network.getClientTransport('client');
  clientTransport.reconnectOnConnectionDrop = false;
  cleanups.push(() => {
    gate.resolve();
    uploadGate.resolve();
    blocker.close();
    clientTransport.close();
  });
  const { server, transport } = startServer();
  const options: Partial<ClientOptions> = {};
  if (maxResends !== undefined)
    options.resendRefusedCalls = { maxResends, newSessionWaitMs };
  const client = createClient<typeof services>(
    clientTransport,
    'SERVER',
    options,
  );
  async function block() {
    void createClient<typeof services>(blocker, 'SERVER').test.rpc.rpc(true);
    await waitFor(() => expect(effects).toContain('hold'));
  }
  function reconnect() {
    clientTransport.hardDisconnect();
    clientTransport.connect('SERVER');
  }

  return {
    server,
    transport,
    client,
    gate,
    uploadGate,
    effects,
    attempts,
    startServer,
    block,
    reconnect,
  };
}

const refusal = {
  ok: false,
  payload: {
    code: 'SERVER_DRAINING',
    message: 'Server is draining; the procedure was not run',
  },
};

test('drain refuses calls before middleware or handler runs', async () => {
  // Risk: a refused call that ran would be unsafe to resend.
  const middlewareEffects: Array<string> = [];
  const f = setup(undefined, 1000, [
    ({ next }) => {
      middlewareEffects.push('middleware');
      next();
    },
  ]);
  await f.block();
  middlewareEffects.length = 0;
  void f.server.drain({ budgetMs: 10000 });
  expect(await f.client.test.rpc.rpc(false)).toEqual(refusal);
  expect(middlewareEffects).toEqual([]);
  expect(f.effects).toEqual(['hold']);
});

test('drain inside middleware waits for its admitted rpc result', async () => {
  // Risk: an accepted call is closed as if the server were idle.
  const f = setup(undefined, 1000, [
    ({ next }) => {
      void f.server.drain({ budgetMs: 10000 });
      next();
    },
  ]);
  const result = f.client.test.rpc.rpc(true);
  await waitFor(() => expect(f.effects).toContain('hold'));
  expect(f.transport.getStatus()).not.toBe('closed');
  f.gate.resolve();
  expect(await result).toEqual(Ok(null));
  await f.server.drain({ budgetMs: 10000 });
  expect(f.transport.getStatus()).toBe('closed');
});

test('a subscription does not hold drain after rpc and upload finish', async () => {
  // Risk: long streams keep clients on the old server for the whole budget.
  const f = setup();
  expect(
    await readNextResult(f.client.test.subscription.subscribe({}).resReadable),
  ).toEqual(Ok(null));
  const rpc = f.client.test.rpc.rpc(true);
  const upload = f.client.test.upload.upload({}).finalize();
  await waitFor(() => expect(f.effects).toEqual(['hold', 'upload']));
  const draining = f.server.drain({ budgetMs: 10000 });
  f.gate.resolve();
  expect(await rpc).toEqual(Ok(null));
  expect(f.transport.getStatus()).not.toBe('closed');
  f.uploadGate.resolve();
  expect(await upload).toEqual(Ok(null));
  expect(f.transport.getStatus()).toBe('closed');
  await draining;
  expect(f.transport.sessions.size).toBe(0);
  expect(f.server.streams.size).toBe(0);
});

test('the drain budget closes a server whose rpc never returns', async () => {
  // Risk: shutdown hangs.
  const f = setup();
  await f.block();
  const draining = f.server.drain({ budgetMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  expect(f.transport.getStatus()).toBe('closed');
  await draining;
});

test('a refused rpc waits for a connected session with a new id', async () => {
  // Risk: replaying work on the draining server.
  const f = setup(2);
  await f.block();
  const draining = f.server.drain({ budgetMs: 10000 });
  const result = f.client.test.rpc.rpc(false);
  await waitFor(() => expect(f.attempts).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(20);
  expect(f.attempts).toHaveLength(1);
  f.gate.resolve();
  await draining;
  f.startServer();
  f.reconnect();
  expect(await result).toEqual(Ok(null));
  expect(f.attempts).toHaveLength(2);
  expect(f.attempts[1]).not.toBe(f.attempts[0]);
  expect(f.effects).toEqual(['hold', 'rpc']);
});

test('successive refusals stop after a positive resend budget', async () => {
  // Risk: unbounded replay.
  const f = setup(2);
  await f.block();
  void f.server.drain({ budgetMs: 10000 });
  const result = f.client.test.rpc.rpc(false);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitFor(() => expect(f.attempts).toHaveLength(attempt));
    await vi.advanceTimersByTimeAsync(10);
    f.reconnect();
  }
  await vi.advanceTimersByTimeAsync(20);
  expect(f.attempts).toHaveLength(3);
  expect(await result).toEqual(refusal);
  expect(f.effects).toEqual(['hold']);
});

test('a negative resend budget returns the first refusal', async () => {
  // Risk: a finite resend budget is rejected instead of disabling resend.
  const f = setup(-1);
  await f.block();
  void f.server.drain({ budgetMs: 10000 });
  expect(await f.client.test.rpc.rpc(false)).toEqual(refusal);
  expect(f.attempts).toHaveLength(1);
  expect(f.effects).toEqual(['hold']);
});

test('the session wait deadline returns the original refusal', async () => {
  // Risk: the rpc stays pending forever.
  const f = setup(2, 100);
  await f.block();
  void f.server.drain({ budgetMs: 10000 });
  const result = f.client.test.rpc.rpc(false);
  await waitFor(() => expect(f.attempts).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toEqual(refusal);
  expect(f.effects).toEqual(['hold']);
});

test('abort while waiting preserves the refusal and removes the waiter', async () => {
  // Risk: cancelled work still runs.
  const f = setup(2, 30000);
  await f.block();
  const draining = f.server.drain({ budgetMs: 10000 });
  const controller = new AbortController();
  const result = f.client.test.rpc.rpc(false, { signal: controller.signal });
  await waitFor(() => expect(f.attempts).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  expect(await result).toEqual(refusal);
  f.gate.resolve();
  await draining;
  f.startServer();
  f.reconnect();
  await vi.advanceTimersByTimeAsync(50);
  expect(f.effects).toEqual(['hold']);
  expect(f.attempts).toHaveLength(1);
});

test('a refused upload is returned without replay', async () => {
  // Risk: replaying a consumed upload.
  const f = setup(2);
  await f.block();
  void f.server.drain({ budgetMs: 10000 });
  expect(await f.client.test.upload.upload({}).finalize()).toEqual(refusal);
  expect(f.effects).toEqual(['hold']);
});

test('a handler that returns the reserved drain code is not resent', async () => {
  // Risk: a handler that already ran is replayed on the next session.
  const f = setup(1);
  const result = f.client.test.claim.rpc({});
  await waitFor(() => expect(f.effects).toEqual(['claim']));
  await vi.advanceTimersByTimeAsync(10);
  f.reconnect();
  await vi.advanceTimersByTimeAsync(20);
  expect(f.effects).toEqual(['claim']);
  expect(await result).toMatchObject({
    ok: false,
    payload: { code: UNCAUGHT_ERROR_CODE, message: 'upstream' },
  });
});
