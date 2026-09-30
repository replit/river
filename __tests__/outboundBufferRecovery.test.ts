import { afterEach, assert, expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import {
  createClient,
  createServer,
  createServiceSchema,
  Ok,
  Procedure,
  UNEXPECTED_DISCONNECT_CODE,
} from '../router';
import {
  createClient as createProtoClient,
  createServer as createProtoServer,
  createProtoService,
  ProtoCodec,
} from '../protobuf';
import { TestService } from '../testUtil/fixtures/protobuf';
import {
  transports,
  type TestSetupHelpers,
} from '../testUtil/fixtures/transports';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { SessionState } from '../transport/sessionStateMachine';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import { WebSocketServerTransport } from '../transport/impls/ws/server';

const limit = { maxBytes: 1024, closeCode: 1013, closeReason: 'history full' };
const cleanups: Array<() => void | Promise<void>> = [];
let setup: TestSetupHelpers | undefined;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await setup?.cleanup();
  setup = undefined;
});

test('a terminal close fails the original call before a reconnect beyond server grace can replay it', async () => {
  const ws = transports.find((entry) => entry.name === 'ws');
  assert(ws);
  const clientOptions = {
    nonResumableCloseCodes: [limit.closeCode],
    sessionDisconnectGraceMs: 10000,
    heartbeatIntervalMs: 10000,
    baseIntervalMs: 500,
    maxBackoffMs: 500,
    maxJitterMs: 0,
  };
  setup = await ws.setup({
    client: clientOptions,
    server: {
      outboundBufferLimit: limit,
      sessionDisconnectGraceMs: 100,
      handshakeTimeoutMs: 100,
      heartbeatIntervalMs: 10000,
    },
  });
  const clientTransport = setup.getClientTransport('client');
  const serverTransport = setup.getServerTransport();
  let closedAt = 0;
  clientTransport.addEventListener('sessionStatus', (event) => {
    if (event.status === 'closing') closedAt = Date.now();
  });
  let calls = 0;
  const services = {
    test: createServiceSchema().define({
      call: Procedure.rpc({
        requestInit: Type.Object({}),
        responseData: Type.String(),
        handler: async () =>
          Ok(++calls === 1 ? 'x'.repeat(limit.maxBytes) : 'executed again'),
      }),
    }),
  };
  const server = createServer(serverTransport, services);
  cleanups.push(
    () => {
      clientTransport.close();
      serverTransport.close();
    },
    () => server.close(),
  );
  const client = createClient<typeof services>(
    clientTransport,
    serverTransport.clientId,
  );
  const result = client.test.call.rpc({});
  const oldId = clientTransport.sessions.get(serverTransport.clientId)?.id;
  await expect(result).resolves.toMatchObject({
    ok: false,
    payload: { code: UNEXPECTED_DISCONNECT_CODE },
  });
  await vi.waitFor(
    () => {
      const session = clientTransport.sessions.get(serverTransport.clientId);
      expect(session?.state).toBe(SessionState.Connected);
      expect(session?.id).not.toBe(oldId);
    },
    { timeout: 3000, interval: 10 },
  );
  expect(Date.now() - closedAt).toBeGreaterThan(200);
  expect(calls).toBe(1);
  await expect(client.test.call.rpc({})).resolves.toEqual(Ok('executed again'));
  expect(calls).toBe(2);
}, 5000);

test('a terminal close during connection establishment fails queued calls before a fresh handshake', async () => {
  const ws = transports.find((entry) => entry.name === 'ws');
  assert(ws);
  setup = await ws.setup({
    client: { nonResumableCloseCodes: [limit.closeCode] },
  });
  const clientTransport = setup.getClientTransport('client');
  const serverTransport = setup.getServerTransport();
  assert(serverTransport instanceof WebSocketServerTransport);
  serverTransport.wss.once('connection', (socket) =>
    socket.close(limit.closeCode, limit.closeReason),
  );
  let calls = 0;
  const services = {
    test: createServiceSchema().define({
      call: Procedure.rpc({
        requestInit: Type.Object({}),
        responseData: Type.String(),
        handler: async () => {
          calls++;

          return Ok('explicit retry');
        },
      }),
    }),
  };
  const server = createServer(serverTransport, services);
  cleanups.push(
    () => {
      clientTransport.close();
      serverTransport.close();
    },
    () => server.close(),
  );
  const client = createClient<typeof services>(
    clientTransport,
    serverTransport.clientId,
  );
  const result = client.test.call.rpc({});
  const oldId = clientTransport.sessions.get(serverTransport.clientId)?.id;
  await expect(result).resolves.toMatchObject({
    ok: false,
    payload: { code: UNEXPECTED_DISCONNECT_CODE },
  });
  await waitFor(() => {
    const session = clientTransport.sessions.get(serverTransport.clientId);
    expect(session?.state).toBe(SessionState.Connected);
    expect(session?.id).not.toBe(oldId);
  });
  expect(calls).toBe(0);
  await expect(client.test.call.rpc({})).resolves.toEqual(Ok('explicit retry'));
  expect(calls).toBe(1);
});

test.each([
  ['typebox', false],
  ['protobuf', false],
  ['typebox', true],
  ['protobuf', true],
] as const)(
  '%s deferred middleware cannot revive a disposed stream (throwing logger: %s)',
  async (router, throwingLogger) => {
    const ws = transports.find((entry) => entry.name === 'ws');
    assert(ws);
    const codec = router === 'protobuf' ? ProtoCodec : undefined;
    setup = await ws.setup({
      client: codec ? { codec } : {},
      server: { ...(codec ? { codec } : {}), outboundBufferLimit: limit },
    });
    const clientTransport = setup.getClientTransport('client');
    const serverTransport = setup.getServerTransport();
    clientTransport.reconnectOnConnectionDrop = false;
    cleanups.push(() => {
      clientTransport.close();
      serverTransport.close();
    });
    let next: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    let cleaned = 0;
    let calls = 0;
    if (throwingLogger)
      serverTransport.bindLogger((message) => {
        if (
          message.includes('cleaning up') ||
          message.includes('closed overflowing')
        )
          throw new Error('cleanup logger failed');
      });
    const middleware = (param: {
      ctx: { signal: AbortSignal; deferCleanup(fn: () => void): void };
      next: () => void;
    }) => {
      next = param.next;
      signal = param.ctx.signal;
      param.ctx.deferCleanup(() => {
        cleaned++;
      });
    };
    let server: {
      streams: ReadonlyMap<string, unknown>;
      close(): Promise<void>;
    };
    if (router === 'typebox') {
      const services = {
        test: createServiceSchema().define({
          hold: Procedure.subscription({
            requestInit: Type.Object({}),
            responseData: Type.String(),
            handler: async () => {
              calls++;
            },
          }),
        }),
      };
      server = createServer(serverTransport, services, {
        middlewares: [middleware],
      });
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      client.test.hold.subscribe({});
    } else {
      server = createProtoServer(
        serverTransport,
        [
          createProtoService().define(TestService, {
            countUp: () => {
              calls++;
            },
          }),
        ],
        { middlewares: [middleware] },
      );
      createProtoClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
      ).countUp({ limit: 1 });
    }
    cleanups.push(() => server.close());
    await waitFor(() => expect(server.streams.size).toBe(1));
    const session = serverTransport.sessions.get('client');
    assert(session);
    expect(
      session.send({
        streamId: 'overflow',
        controlFlags: 0,
        payload: 'x'.repeat(limit.maxBytes),
      }).ok,
    ).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(cleaned).toBe(1);
    assert(next);
    next();
    expect(calls).toBe(0);
    expect(server.streams.size).toBe(0);
  },
);

test('overflow contains rejected asynchronous observers and thenables while completing disposal', async () => {
  const ws = transports.find((entry) => entry.name === 'ws');
  assert(ws);
  setup = await ws.setup({ server: { outboundBufferLimit: limit } });
  const client = setup.getClientTransport('client');
  const server = setup.getServerTransport();
  client.reconnectOnConnectionDrop = false;
  cleanups.push(() => {
    client.close();
    server.close();
  });
  let asyncObserved = false;
  let thenableObserved = false;
  let closedObserved = false;
  server.addEventListener('sessionStatus', async (event) => {
    if (event.status !== 'closing') return;
    await Promise.resolve();
    asyncObserved = true;
    throw new Error('async closing observer failed');
  });
  server.addEventListener('sessionStatus', (event) => {
    if (event.status !== 'closing') return;

    return {
      then: (_resolve: unknown, reject: (reason: Error) => void) => {
        thenableObserved = true;
        reject(new Error('closing thenable failed'));
      },
    };
  });
  server.addEventListener('sessionStatus', (event) => {
    if (event.status === 'closed') closedObserved = true;
  });
  client.connect(server.clientId);
  await waitFor(() =>
    expect(client.sessions.get(server.clientId)?.state).toBe(
      SessionState.Connected,
    ),
  );
  const session = server.sessions.get(client.clientId);
  assert(session);
  const history = session.sendBuffer;
  const counter = session.outboundBuffer;
  expect(() =>
    server.getSessionBoundSendFn(
      client.clientId,
      session.id,
    )({
      streamId: 'overflow',
      controlFlags: 0,
      payload: 'x'.repeat(limit.maxBytes),
    }),
  ).toThrow('outbound replay history limit exceeded');
  await vi.advanceTimersByTimeAsync(10);
  expect(asyncObserved).toBe(true);
  expect(thenableObserved).toBe(true);
  expect(closedObserved).toBe(true);
  expect(server.sessions.size).toBe(0);
  expect(history).toHaveLength(0);
  expect(counter?.bytes).toBe(0);
});

test.each([
  SessionState.NoConnection,
  SessionState.Connecting,
  SessionState.Handshaking,
])(
  '%s transition can synchronously dispose its session without resuming consumed state',
  async (state) => {
    const ws = transports.find((entry) => entry.name === 'ws');
    assert(ws);
    setup = await ws.setup({
      client: { outboundBufferLimit: { ...limit, closeCode: 4008 } },
    });
    const client = setup.getClientTransport('client');
    const server = setup.getServerTransport();
    client.reconnectOnConnectionDrop = false;
    cleanups.push(() => {
      client.close();
      server.close();
    });
    if (state === SessionState.NoConnection) {
      client.connect(server.clientId);
      await waitFor(() =>
        expect(client.sessions.get(server.clientId)?.state).toBe(
          SessionState.Connected,
        ),
      );
    }
    let observed = false;
    client.addEventListener('sessionTransition', (event) => {
      if (event.state !== state) return;
      observed = true;
      client.getSessionBoundSendFn(
        server.clientId,
        event.id,
      )({
        streamId: 'overflow',
        controlFlags: 0,
        payload: 'x'.repeat(limit.maxBytes),
      });
    });
    if (state === SessionState.NoConnection) {
      const session = client.sessions.get(server.clientId);
      assert(session?.state === SessionState.Connected);
      session.conn.close();
    } else {
      client.connect(server.clientId);
    }
    await waitFor(() => expect(observed).toBe(true));
    await vi.advanceTimersByTimeAsync(10);
    expect(client.sessions.size).toBe(0);
  },
);

test('received terminal close codes are optional, readonly, and validated separately from outgoing codes', () => {
  const create = (nonResumableCloseCodes?: ReadonlyArray<number>) =>
    new WebSocketClientTransport(
      () => Promise.reject(new Error('unused')),
      'client',
      { nonResumableCloseCodes },
    );
  const valid: ReadonlyArray<number> = [1013, 4008];
  create(valid).close();
  create([]).close();
  create().close();
  for (const code of [NaN, 1004, 1005, 1006, 1015, 2000, 5000, 4000.5]) {
    expect(() => create([code])).toThrow('nonResumableCloseCodes');
  }
  // @ts-expect-error Null is not an omitted list.
  expect(() => create(null)).toThrow('nonResumableCloseCodes');
});
