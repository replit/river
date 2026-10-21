import { afterEach, expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import {
  ClientOptions,
  createClient,
  createServer,
  createServiceSchema,
  Ok,
  Procedure,
  SERVER_DRAINING_CODE,
} from '../router';
import { createMockTransportNetwork, readNextResult } from '../testUtil';
import { waitFor } from '../testUtil/fixtures/cleanup';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: Partial<ClientOptions> = {}) {
  const network = createMockTransportNetwork();
  cleanups.push(() => network.cleanup());
  const clientTransport = network.getClientTransport('client');
  cleanups.push(() => clientTransport.close());
  const ran = vi.fn();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const services = {
    test: createServiceSchema().define({
      hold: Procedure.rpc({
        requestInit: Type.Object({}),
        responseData: Type.Null(),
        async handler() {
          await gate;

          return Ok(null);
        },
      }),
      rpc: Procedure.rpc({
        requestInit: Type.Object({}),
        responseData: Type.Null(),
        async handler() {
          ran();

          return Ok(null);
        },
      }),
      upload: Procedure.upload({
        requestInit: Type.Object({}),
        requestData: Type.Null(),
        responseData: Type.Null(),
        async handler() {
          ran();

          return Ok(null);
        },
      }),
      subscription: Procedure.subscription({
        requestInit: Type.Object({}),
        responseData: Type.Null(),
        async handler({ resWritable }) {
          ran();
          resWritable.close();
        },
      }),
      stream: Procedure.stream({
        requestInit: Type.Object({}),
        requestData: Type.Null(),
        responseData: Type.Null(),
        async handler({ resWritable }) {
          ran();
          resWritable.close();
        },
      }),
    }),
  };
  function startServer() {
    const transport = network.getServerTransport();
    const server = createServer(transport, services);
    cleanups.push(async () => {
      transport.close();
      await server.close();
    });

    return { server, transport };
  }
  const { server, transport } = startServer();
  const client = createClient<typeof services>(
    clientTransport,
    'SERVER',
    options,
  );
  const held = client.test.hold.rpc({});
  await waitFor(() => expect(server.streams.size).toBe(1));
  cleanups.push(release);

  return {
    client,
    clientTransport,
    server,
    transport,
    release,
    held,
    ran,
    startServer,
  };
}

const refusal = {
  ok: false,
  payload: {
    code: SERVER_DRAINING_CODE,
    message: 'Server is draining; the procedure was not run',
  },
};

test.each(['rpc', 'upload', 'subscription', 'stream'] as const)(
  'drain refuses new %s calls without running the handler',
  async (kind) => {
    const f = await setup();
    const draining = f.server.drain({ budgetMs: 10_000 });
    switch (kind) {
      case 'rpc':
        expect(await f.client.test.rpc.rpc({})).toEqual(refusal);
        break;
      case 'upload':
        expect(await f.client.test.upload.upload({}).finalize()).toEqual(
          refusal,
        );
        break;
      case 'subscription':
        expect(
          await readNextResult(
            f.client.test.subscription.subscribe({}).resReadable,
          ),
        ).toEqual(refusal);
        break;
      case 'stream':
        expect(
          await readNextResult(f.client.test.stream.stream({}).resReadable),
        ).toEqual(refusal);
        break;
    }
    expect(f.ran).not.toHaveBeenCalled();
    f.release();
    await draining;
  },
);

test('drain lets an existing RPC finish and removes its session', async () => {
  const f = await setup();
  const done = vi.fn();
  const draining = f.server.drain({ budgetMs: 10_000 }).then(done);
  await vi.advanceTimersByTimeAsync(50);
  expect(done).not.toHaveBeenCalled();
  f.release();
  expect(await f.held).toEqual(Ok(null));
  await draining;
  expect(f.transport.sessions.size).toBe(0);
  expect(f.transport.getStatus()).toBe('closed');
});

test('drain closes at the budget even when a handler is still running', async () => {
  const f = await setup();
  const draining = f.server.drain({ budgetMs: 1_000 });
  await vi.advanceTimersByTimeAsync(1_000);
  await draining;
  expect(f.transport.getStatus()).toBe('closed');
  expect(f.transport.sessions.size).toBe(0);
});

test('repeated drains share the same completion', async () => {
  const f = await setup();
  const first = f.server.drain({ budgetMs: 1_000 });
  expect(f.server.drain({ budgetMs: 0 })).toBe(first);
  f.release();
  await first;
  expect(f.server.drain({ budgetMs: 0 })).toBe(first);
});

test('opt-in RPC resend waits for a different session', async () => {
  const f = await setup({
    resendRefusedCalls: { maxResends: 1, newSessionWaitMs: 30_000 },
  });
  const previous = f.clientTransport.sessions.get('SERVER')?.id;
  const draining = f.server.drain({ budgetMs: 10_000 });
  const done = vi.fn();
  const result = f.client.test.rpc.rpc({}).then((value) => {
    done();

    return value;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(done).not.toHaveBeenCalled();
  f.release();
  await draining;
  f.startServer();
  expect(await result).toEqual(Ok(null));
  expect(f.clientTransport.sessions.get('SERVER')?.id).not.toBe(previous);
  expect(f.ran).toHaveBeenCalledTimes(1);
});

test('resend wait timeout surfaces the original refusal', async () => {
  const f = await setup({
    resendRefusedCalls: { maxResends: 1, newSessionWaitMs: 100 },
  });
  void f.server.drain({ budgetMs: 10_000 });
  const done = vi.fn();
  const result = f.client.test.rpc.rpc({}).then((value) => {
    done();

    return value;
  });
  await vi.advanceTimersByTimeAsync(30);
  expect(done).not.toHaveBeenCalled();
  expect(await result).toEqual(refusal);
  expect(f.ran).not.toHaveBeenCalled();
});

test('zero resend budget surfaces the refusal without waiting', async () => {
  const f = await setup({
    resendRefusedCalls: { maxResends: 0, newSessionWaitMs: 30_000 },
  });
  void f.server.drain({ budgetMs: 10_000 });
  expect(await f.client.test.rpc.rpc({})).toEqual(refusal);
});

test('abort stops waiting for a new session and preserves the refusal', async () => {
  const f = await setup({
    resendRefusedCalls: { maxResends: 1, newSessionWaitMs: 30_000 },
  });
  void f.server.drain({ budgetMs: 10_000 });
  const controller = new AbortController();
  const done = vi.fn();
  const result = f.client.test.rpc
    .rpc({}, { signal: controller.signal })
    .then((value) => {
      done();

      return value;
    });
  await vi.advanceTimersByTimeAsync(100);
  expect(done).not.toHaveBeenCalled();
  controller.abort();
  expect(await result).toEqual(refusal);
});

test('opt-in does not replay an upload refusal', async () => {
  const f = await setup({
    resendRefusedCalls: { maxResends: 1, newSessionWaitMs: 30_000 },
  });
  void f.server.drain({ budgetMs: 10_000 });
  expect(await f.client.test.upload.upload({}).finalize()).toEqual(refusal);
});
