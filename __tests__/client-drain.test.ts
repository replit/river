import { afterEach, expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import {
  createClient,
  createServer,
  createServiceSchema,
  Ok,
  Procedure,
} from '../router';
import { createMockTransportNetwork } from '../testUtil';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { createPromiseWithResolvers } from '../transport/promises';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(maxResends = 2, newSessionWaitMs = 1000) {
  const network = createMockTransportNetwork();
  const gate = createPromiseWithResolvers<void>();
  const effects: Array<string> = [];
  const attempts: Array<string | undefined> = [];
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
      upload: Procedure.upload({
        requestInit: Type.Object({}),
        requestData: Type.Null(),
        responseData: Type.Null(),
        async handler() {
          effects.push('upload');

          return Ok(null);
        },
      }),
    }),
  };
  function startServer() {
    const transport = network.getServerTransport();
    const server = createServer(transport, services);
    transport.addEventListener('message', (message) => {
      if (message.procedureName === 'rpc')
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
    blocker.close();
    clientTransport.close();
  });
  const { server, transport } = startServer();
  const client = createClient<typeof services>(clientTransport, 'SERVER', {
    resendRefusedCalls: { maxResends, newSessionWaitMs },
  });
  void createClient<typeof services>(blocker, 'SERVER').test.hold.rpc({});
  await waitFor(() => expect(effects).toEqual(['hold']));
  const draining = server.drain({ budgetMs: 10000 });

  return {
    client,
    clientTransport,
    gate,
    effects,
    attempts,
    draining,
    transport,
    startServer,
  };
}

const refusal = {
  ok: false,
  payload: {
    code: 'SERVER_DRAINING',
    message: 'Server is draining; the procedure was not run',
  },
};

test('a refused rpc waits for a connected session with a new id', async () => {
  // Risk: replaying work on the draining server.
  const f = await setup();
  const result = f.client.test.rpc.rpc({});
  await waitFor(() => expect(f.attempts).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(20);
  expect(f.attempts).toHaveLength(1);
  f.gate.resolve();
  await f.draining;
  f.startServer();
  f.clientTransport.hardDisconnect();
  f.clientTransport.connect('SERVER');
  expect(await result).toEqual(Ok(null));
  expect(f.attempts).toHaveLength(2);
  expect(f.attempts[1]).not.toBe(f.attempts[0]);
  expect(f.effects).toEqual(['hold', 'rpc']);
});

test('successive refusals stop after a positive resend budget', async () => {
  // Risk: unbounded replay.
  const f = await setup(2);
  const result = f.client.test.rpc.rpc({});
  for (let attempt = 1; attempt <= 3; attempt++) {
    await waitFor(() => expect(f.attempts).toHaveLength(attempt));
    await vi.advanceTimersByTimeAsync(10);
    f.clientTransport.hardDisconnect();
    f.clientTransport.connect('SERVER');
  }
  expect(await result).toEqual(refusal);
  await vi.advanceTimersByTimeAsync(20);
  expect(f.attempts).toHaveLength(3);
  expect(f.effects).toEqual(['hold']);
});

test('the session wait deadline returns the original refusal', async () => {
  // Risk: the rpc stays pending forever.
  const f = await setup(2, 100);
  const result = f.client.test.rpc.rpc({});
  await waitFor(() => expect(f.attempts).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toEqual(refusal);
  expect(f.effects).toEqual(['hold']);
});

test('abort while waiting preserves the refusal and removes the waiter', async () => {
  // Risk: cancelled work still runs.
  const f = await setup(2, 30_000);
  const waiting = new AbortController();
  const first = f.client.test.rpc.rpc({}, { signal: waiting.signal });
  await waitFor(() => expect(f.attempts).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(10);
  waiting.abort();
  expect(await first).toEqual(refusal);
  f.gate.resolve();
  await f.draining;
  f.startServer();
  f.clientTransport.hardDisconnect();
  f.clientTransport.connect('SERVER');
  await vi.advanceTimersByTimeAsync(500);
  expect(f.effects).toEqual(['hold']);
  expect(f.attempts).toHaveLength(1);
});

test('a refused upload is returned without replay', async () => {
  // Risk: replaying a consumed upload.
  const f = await setup();
  expect(await f.client.test.upload.upload({}).finalize()).toEqual(refusal);
  expect(f.effects).toEqual(['hold']);
});
