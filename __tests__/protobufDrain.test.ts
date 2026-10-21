import { afterEach, expect, test, vi } from 'vitest';
import {
  createClient,
  createProtoService,
  createServer,
  Err,
  Middleware,
  Ok,
  ProtoCodec,
  SERVER_DRAINING_CODE,
  UNCAUGHT_ERROR_CODE,
} from '../protobuf';
import { createMockTransportNetwork, readNextResult } from '../testUtil';
import { TestService } from '../testUtil/fixtures/protobuf';
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
    client: { codec: ProtoCodec, baseIntervalMs: 1, maxJitterMs: 0 },
    server: { codec: ProtoCodec },
  });
  const gate = createPromiseWithResolvers<void>();
  const uploadGate = createPromiseWithResolvers<void>();
  const effects: Array<string> = [];
  const attempts: Array<string | undefined> = [];
  const service = createProtoService().define(TestService, {
    echo: async ({ text }) => {
      effects.push(text);
      if (text === 'hold') await gate.promise;
      if (text === 'claim')
        return Err({ code: SERVER_DRAINING_CODE, message: 'upstream' });

      return Ok({ text: 'ok' });
    },
    countUp: ({ resWritable }) => {
      resWritable.write(Ok({ value: 1 }));
    },
    sum: async () => {
      effects.push('sum');
      await uploadGate.promise;

      return Ok({ total: 1 });
    },
  });
  function startServer() {
    const transport = network.getServerTransport();
    const server = createServer(transport, [service], { middlewares });
    transport.addEventListener('message', (message) => {
      if (message.from === 'client' && message.procedureName === 'Echo')
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
  const client = createClient(
    TestService,
    clientTransport,
    'SERVER',
    maxResends === undefined
      ? {}
      : { resendRefusedCalls: { maxResends, newSessionWaitMs } },
  );
  async function block() {
    void createClient(TestService, blocker, 'SERVER').echo({ text: 'hold' });
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

const refusal = { ok: false, payload: { code: 'SERVER_DRAINING' } };
const success = { ok: true, payload: { text: 'ok' } };

test('drain refuses calls before middleware and handler run', async () => {
  // Risk: a refused call that ran would be unsafe to resend.
  const middlewareEffects: Array<string> = [];
  const f = setup(undefined, 1000, [
    ({ next }) => {
      middlewareEffects.push('ran');
      next();
    },
  ]);
  await f.block();
  middlewareEffects.length = 0;
  void f.server.drain({ budgetMs: 10000 });
  expect(await f.client.echo({ text: 'run' })).toMatchObject(refusal);
  expect(middlewareEffects).toEqual([]);
  expect(f.effects).toEqual(['hold']);
});

test('drain waits for unary and client-streaming calls but not a server stream', async () => {
  // Risk: drain drops accepted calls or waits for a long stream.
  const f = setup();
  await readNextResult(f.client.countUp({ limit: 1 }));
  const unary = f.client.echo({ text: 'hold' });
  const upload = f.client.sum().finalize();
  await waitFor(() => expect(f.effects).toEqual(['hold', 'sum']));
  const draining = f.server.drain({ budgetMs: 10000 });
  expect(f.server.drain({ budgetMs: 1 })).toBe(draining);
  f.gate.resolve();
  expect(await unary).toMatchObject(success);
  expect(f.transport.getStatus()).not.toBe('closed');
  f.uploadGate.resolve();
  expect(await upload).toMatchObject({ ok: true, payload: { total: 1 } });
  await draining;
  expect(f.transport.getStatus()).toBe('closed');
});

test('the drain budget closes a server whose unary call never returns', async () => {
  // Risk: shutdown hangs.
  const f = setup();
  await f.block();
  const draining = f.server.drain({ budgetMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  expect(f.transport.getStatus()).toBe('closed');
  await draining;
});

test('a refused unary call succeeds only on a new session', async () => {
  // Risk: replaying work on the draining session.
  const f = setup(2);
  await f.block();
  const draining = f.server.drain({ budgetMs: 10000 });
  const result = f.client.echo({ text: 'run' });
  await waitFor(() => expect(f.attempts).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(20);
  expect(f.attempts).toHaveLength(1);
  f.gate.resolve();
  await draining;
  f.startServer();
  f.reconnect();
  expect(await result).toMatchObject(success);
  expect(f.attempts).toHaveLength(2);
  expect(f.attempts[1]).not.toBe(f.attempts[0]);
  expect(f.effects).toEqual(['hold', 'run']);
});

test('successive refusals stop at maxResends', async () => {
  // Risk: unbounded replay.
  const f = setup(2);
  await f.block();
  void f.server.drain({ budgetMs: 10000 });
  const result = f.client.echo({ text: 'run' });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitFor(() => expect(f.attempts).toHaveLength(attempt));
    await vi.advanceTimersByTimeAsync(10);
    f.reconnect();
  }
  await vi.advanceTimersByTimeAsync(20);
  expect(f.attempts).toHaveLength(3);
  expect(await result).toMatchObject(refusal);
  expect(f.effects).toEqual(['hold']);
});

test('the session wait deadline returns the refusal', async () => {
  // Risk: a refused call stays pending forever.
  const f = setup(2, 100);
  await f.block();
  void f.server.drain({ budgetMs: 10000 });
  const result = f.client.echo({ text: 'run' });
  await waitFor(() => expect(f.attempts).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject(refusal);
  expect(f.effects).toEqual(['hold']);
});

test('a refused client-streaming call is never resent', async () => {
  // Risk: replaying a consumed request stream.
  const f = setup(2);
  await f.block();
  void f.server.drain({ budgetMs: 10000 });
  expect(await f.client.sum().finalize()).toMatchObject(refusal);
  expect(f.effects).toEqual(['hold']);
});

test('a handler that returns the reserved drain code is not resent', async () => {
  // Risk: a handler that already ran is replayed on the next session.
  const f = setup(1);
  const result = f.client.echo({ text: 'claim' });
  await waitFor(() => expect(f.attempts).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(10);
  f.reconnect();
  await vi.advanceTimersByTimeAsync(20);
  expect(f.effects).toEqual(['claim']);
  expect(await result).toMatchObject({
    ok: false,
    payload: { code: UNCAUGHT_ERROR_CODE, message: 'upstream' },
  });
});

test('drain called from middleware waits for its admitted unary call', async () => {
  // Risk: drain closes a call before middleware admits its handler.
  const f = setup(undefined, 1000, [
    ({ next }) => {
      void f.server.drain({ budgetMs: 10000 });
      next();
    },
  ]);
  const result = f.client.echo({ text: 'hold' });
  await waitFor(() => expect(f.effects).toContain('hold'));
  expect(f.transport.getStatus()).not.toBe('closed');
  f.gate.resolve();
  expect(await result).toMatchObject(success);
  await f.server.drain({ budgetMs: 10000 });
});

test('abort while waiting preserves the refusal without a later resend', async () => {
  // Risk: cancelled work still runs after reconnect.
  const f = setup(2, 30000);
  await f.block();
  const draining = f.server.drain({ budgetMs: 10000 });
  const controller = new AbortController();
  const result = f.client.echo({ text: 'run' }, { signal: controller.signal });
  await waitFor(() => expect(f.attempts).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  expect(await result).toMatchObject(refusal);
  f.gate.resolve();
  await draining;
  f.startServer();
  f.reconnect();
  await vi.advanceTimersByTimeAsync(50);
  expect(f.effects).toEqual(['hold']);
  expect(f.attempts).toHaveLength(1);
});
