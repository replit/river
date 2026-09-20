import { afterEach, assert, expect, expectTypeOf, test, vi } from 'vitest';
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
  transports,
  type TestSetupHelpers,
  type TestTransportOptions,
} from '../testUtil/fixtures/transports';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { NaiveJsonCodec, type Codec } from '../codec';
import { SessionState } from '../transport/sessionStateMachine';
import { WebSocketConnection } from '../transport/impls/ws/connection';
import { type PartialTransportMessage } from '../transport/message';
import {
  createClient as createProtoClient,
  createServer as createProtoServer,
  createProtoService,
  ProtoCodec,
} from '../protobuf';
import { TestService } from '../testUtil/fixtures/protobuf';
import { TestServiceSchema } from '../testUtil/fixtures/services';
import { readNextResult } from '../testUtil';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import { type TransportOptions } from '../transport/options';
import { type SessionBoundSendFn } from '../transport/transport';

const limit = {
  maxBytes: 1024,
  closeCode: 4008,
  closeReason: 'replay history full',
};
const ws = transports.find((transport) => transport.name === 'ws');
assert(ws);
let setup: TestSetupHelpers | undefined;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await setup?.cleanup();
  setup = undefined;
});

async function start(options: TestTransportOptions) {
  assert(ws);
  setup = await ws.setup({
    ...options,
    client: { nonResumableCloseCodes: [limit.closeCode], ...options.client },
  });
  const clientTransport = setup.getClientTransport('client');
  const serverTransport = setup.getServerTransport();
  cleanups.push(() => {
    clientTransport.close();
    serverTransport.close();
  });

  return { clientTransport, serverTransport };
}

const frameBytes = 256;
function pooledCodec() {
  const backing = new Uint8Array(8192);
  const codec: Codec = {
    toBuffer: (message) => {
      const json = NaiveJsonCodec.toBuffer(message);
      const view = backing.subarray(
        32,
        32 + Math.max(frameBytes, json.byteLength),
      );
      view.fill(32);
      view.set(json);

      return view;
    },
    fromBuffer: (data) => NaiveJsonCodec.fromBuffer(data),
  };

  return { codec, backing };
}

test('first synchronous response overflow aborts the handler and runs deferred cleanup', async () => {
  const options = { outboundBufferLimit: limit, heartbeatIntervalMs: 10000 };
  const { clientTransport, serverTransport } = await start({ server: options });
  let signal: AbortSignal | undefined;
  let otherSignal: AbortSignal | undefined;
  let cleaned = 0;
  let writeReturned = false;
  const services = {
    test: createServiceSchema().define({
      flood: Procedure.subscription({
        requestInit: Type.Object({
          mode: Type.Union([
            Type.Literal('hold'),
            Type.Literal('flood'),
            Type.Literal('reopen'),
          ]),
        }),
        responseData: Type.String(),
        handler: async ({ ctx, reqInit, resWritable }) => {
          if (reqInit.mode === 'reopen') {
            resWritable.close(Ok('reopened'));

            return;
          }
          ctx.deferCleanup(() => {
            cleaned++;
          });
          if (reqInit.mode === 'hold') {
            otherSignal = ctx.signal;

            return;
          }
          signal = ctx.signal;
          resWritable.write(Ok('x'.repeat(limit.maxBytes)));
          writeReturned = true;
        },
      }),
    }),
  };
  let reentrantError: unknown;
  let reentrantSend: SessionBoundSendFn | undefined;
  let closingSeq: number | undefined;
  serverTransport.addEventListener('sessionStatus', (event) => {
    if (event.status === 'created')
      reentrantSend = serverTransport.getSessionBoundSendFn(
        event.session.to,
        event.session.id,
      );
    if (event.status !== 'closing' || !event.session.outboundBuffer?.overflowed)
      return;
    closingSeq = event.session.seq;
    try {
      reentrantSend?.({
        streamId: 'observer',
        controlFlags: 0,
        payload: {},
      });
    } catch (error) {
      reentrantError = error;
    }
    throw new Error('broken closing observer');
  });
  const server = createServer(serverTransport, services);
  const client = createClient<typeof services>(
    clientTransport,
    serverTransport.clientId,
  );
  cleanups.push(() => server.close());
  clientTransport.connect(serverTransport.clientId);
  await waitFor(() =>
    expect(clientTransport.sessions.get(serverTransport.clientId)?.state).toBe(
      SessionState.Connected,
    ),
  );
  const session = clientTransport.sessions.get(serverTransport.clientId);
  assert(session?.state === SessionState.Connected);
  assert(session.conn instanceof WebSocketConnection);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    assert(session.conn instanceof WebSocketConnection);
    const onclose = session.conn.ws.onclose;
    session.conn.ws.onclose = (event) => {
      resolve(event);
      onclose?.(event);
    };
  });
  const other = client.test.flood.subscribe({ mode: 'hold' }).resReadable;
  await waitFor(() => expect(otherSignal?.aborted).toBe(false));
  const responses = client.test.flood.subscribe({ mode: 'flood' }).resReadable;
  await waitFor(() => expect(signal?.aborted).toBe(true));
  expect(cleaned).toBe(2);
  expect(otherSignal?.aborted).toBe(true);
  expect(writeReturned).toBe(false);
  expect(server.streams.size).toBe(0);
  expect(serverTransport.sessions.size).toBe(0);
  expect(closingSeq).toBe(0);
  expect(reentrantError).toBeInstanceOf(Error);
  await expect(closed).resolves.toMatchObject({
    code: limit.closeCode,
    reason: limit.closeReason,
  });
  expect(await readNextResult(responses)).toMatchObject({
    ok: false,
    payload: { code: UNEXPECTED_DISCONNECT_CODE },
  });
  expect(await readNextResult(other)).toMatchObject({
    ok: false,
    payload: { code: UNEXPECTED_DISCONNECT_CODE },
  });
  await waitFor(() => {
    const fresh = clientTransport.sessions.get(serverTransport.clientId);
    expect(fresh?.state).toBe(SessionState.Connected);
    expect(fresh?.id).not.toBe(session.id);
  });
  const reopened = client.test.flood.subscribe({ mode: 'reopen' }).resReadable;
  expect(await readNextResult(reopened)).toEqual(Ok('reopened'));
});

test('protobuf first-write overflow closes upstream work, including late deferred cleanup', async () => {
  const { clientTransport, serverTransport } = await start({
    client: { codec: ProtoCodec },
    server: { codec: ProtoCodec, outboundBufferLimit: limit },
  });
  let signal: AbortSignal | undefined;
  let cleaned = 0;
  let escaped: unknown;
  const service = createProtoService().define(TestService, {
    countUp: {
      raw: 'both',
      handler: ({ ctx, resWritable }) => {
        signal = ctx.signal;
        ctx.deferCleanup(() => {
          cleaned++;
        });
        try {
          resWritable.write(Ok(new Uint8Array(limit.maxBytes)));
        } catch (error) {
          escaped = error;
        }
        ctx.deferCleanup(() => {
          cleaned++;
        });
      },
    },
  });
  const server = createProtoServer(serverTransport, [service]);
  cleanups.push(() => server.close());
  const client = createProtoClient(
    TestService,
    clientTransport,
    serverTransport.clientId,
  );
  const response = client.countUp({ limit: 1 });
  await waitFor(() => expect(signal?.aborted).toBe(true));
  expect(cleaned).toBe(2);
  expect(escaped).toBeInstanceOf(Error);
  expect(server.streams.size).toBe(0);
  const results = [];
  for await (const result of response) results.push(result);
  expect(results).toMatchObject([
    { ok: false, payload: { code: UNEXPECTED_DISCONNECT_CODE } },
  ]);
});

test('disconnected producers share one byte cap and overflow settles all streams and drain waiters', async () => {
  const { clientTransport, serverTransport } = await start({
    client: { outboundBufferLimit: limit, sendBufferHighWaterMark: 1 },
  });
  const client = createClient<{ test: typeof TestServiceSchema }>(
    clientTransport,
    serverTransport.clientId,
    { eagerlyConnect: false },
  );
  const first = client.test.echo.stream({});
  const second = client.test.echo.stream({});
  const session = clientTransport.sessions.get(serverTransport.clientId);
  assert(session);
  const history = session.sendBuffer;
  const counter = session.outboundBuffer;
  assert(counter);
  expect(
    first.reqWritable.write({ msg: 'accepted under pressure', ignore: true }),
  ).toBe(false);
  expect(counter.bytes).toBeGreaterThan(0);
  expect(counter.bytes).toBeLessThanOrEqual(limit.maxBytes);
  const ready = first.reqWritable.waitForWriteReady();
  let closingSeq: number | undefined;
  clientTransport.addEventListener('sessionStatus', (event) => {
    if (event.status === 'closing') closingSeq = event.session.seq;
  });
  const seq = session.seq;
  const payload = { msg: 'x'.repeat(400), ignore: true };
  const standaloneBytes = NaiveJsonCodec.toBuffer({
    id: history[0].id,
    from: clientTransport.clientId,
    to: serverTransport.clientId,
    seq,
    ack: session.ack,
    streamId: history[1].msg.streamId,
    controlFlags: 0,
    payload,
  }).byteLength;
  expect(standaloneBytes).toBeLessThan(limit.maxBytes);
  expect(standaloneBytes + counter.bytes).toBeGreaterThan(limit.maxBytes);
  expect(() => second.reqWritable.write(payload)).toThrow(
    'outbound replay history limit exceeded',
  );
  expect(closingSeq).toBe(seq);
  expect(counter).toEqual({ bytes: 0, overflowed: true });
  expect(history).toHaveLength(0);
  expect(clientTransport.sessions.size).toBe(0);
  await expect(ready).resolves.toBeUndefined();
  for (const call of [first, second]) {
    expect(call.reqWritable.isWritable()).toBe(false);
    expect(await readNextResult(call.resReadable)).toMatchObject({
      ok: false,
      payload: { code: UNEXPECTED_DISCONNECT_CODE },
    });
  }
});

test('client cancellation overflow settles sibling calls without an unhandled abort callback error', async () => {
  const { codec } = pooledCodec();
  const { clientTransport, serverTransport } = await start({
    client: { codec, outboundBufferLimit: limit },
  });
  const client = createClient<{ test: typeof TestServiceSchema }>(
    clientTransport,
    serverTransport.clientId,
    { eagerlyConnect: false },
  );
  const controller = new AbortController();
  const first = client.test.echo.stream({}, { signal: controller.signal });
  const second = client.test.echo.stream({});
  const counter = clientTransport.sessions.get(serverTransport.clientId)
    ?.outboundBuffer;
  assert(counter);
  while (counter.bytes + frameBytes <= limit.maxBytes) {
    first.reqWritable.write({ msg: 'fill', ignore: true });
  }
  controller.abort();
  await vi.advanceTimersByTimeAsync(10);
  expect(counter).toEqual({ bytes: 0, overflowed: true });
  expect(clientTransport.sessions.size).toBe(0);
  expect(second.reqWritable.isWritable()).toBe(false);
  expect(await readNextResult(second.resReadable)).toMatchObject({
    ok: false,
    payload: { code: UNEXPECTED_DISCONNECT_CODE },
  });
});

test('owned backing capacity is charged once across ACKs, duplicate ACKs, and transparent reconnect', async () => {
  const { codec, backing } = pooledCodec();
  const { clientTransport, serverTransport } = await start({
    server: {
      codec,
      outboundBufferLimit: { ...limit, maxBytes: 3 * frameBytes },
      heartbeatIntervalMs: 10000,
    },
  });
  clientTransport.reconnectOnConnectionDrop = false;
  clientTransport.connect(serverTransport.clientId);
  await waitFor(() =>
    expect(clientTransport.sessions.get(serverTransport.clientId)?.state).toBe(
      SessionState.Connected,
    ),
  );
  const session = serverTransport.sessions.get('client');
  const peer = clientTransport.sessions.get(serverTransport.clientId);
  assert(
    session?.state === SessionState.Connected &&
      peer?.state === SessionState.Connected,
  );
  const send = serverTransport.getSessionBoundSendFn('client', session.id);
  const history = session.sendBuffer;
  const frame: PartialTransportMessage = {
    streamId: 'one',
    controlFlags: 0,
    payload: { text: 'owned' },
  };
  send(frame);
  send({ ...frame, streamId: 'two' });
  const counter = session.outboundBuffer;
  expect(counter?.bytes).toBe(2 * frameBytes);
  for (const entry of session.sendBuffer) {
    expect(entry.byteCharge).toBe(entry.data.buffer.byteLength);
    expect(entry.data.buffer.byteLength).toBe(frameBytes);
    expect(entry.data.buffer).not.toBe(backing.buffer);
    expect(entry.msg).not.toHaveProperty('payload');
    expect(entry.msg).not.toHaveProperty('tracing');
  }
  backing.fill(255);
  await waitFor(() => expect(peer.ack).toBe(2));
  peer.send({ streamId: 'ack', controlFlags: 0, payload: {} });
  const duplicate = peer.sendBuffer[0].data;
  await waitFor(() => expect(counter?.bytes).toBe(0));
  expect(history).toHaveLength(0);
  send(frame);
  peer.conn.send(duplicate);
  await waitFor(() => expect(peer.ack).toBe(3));
  expect(counter?.bytes).toBe(frameBytes);
  peer.conn.close();
  await waitFor(() =>
    expect(serverTransport.sessions.get('client')?.state).toBe(
      SessionState.NoConnection,
    ),
  );
  send({ ...frame, streamId: 'offline' });
  expect(counter?.bytes).toBe(2 * frameBytes);
  clientTransport.connect(serverTransport.clientId);
  await waitFor(() =>
    expect(clientTransport.sessions.get(serverTransport.clientId)?.state).toBe(
      SessionState.Connected,
    ),
  );
  const reconnected = serverTransport.sessions.get('client');
  expect(reconnected?.id).toBe(session.id);
  expect(reconnected?.outboundBuffer).toBe(counter);
  expect(reconnected?.sendBuffer).toBe(history);
  expect(counter?.bytes).toBe(2 * frameBytes);
  expect(reconnected?.sendBuffer).toHaveLength(2);
  const freshPeer = clientTransport.sessions.get(serverTransport.clientId);
  assert(freshPeer?.state === SessionState.Connected);
  await waitFor(() => expect(freshPeer.ack).toBe(4));
  freshPeer.send({ streamId: 'ack', controlFlags: 0, payload: {} });
  await waitFor(() => expect(counter?.bytes).toBe(0));
});

test.each(['close', 'cancel'] as const)(
  'terminal %s overflow cleans a live request without recursive sends',
  async (terminal) => {
    const { codec } = pooledCodec();
    const { clientTransport, serverTransport } = await start({
      server: {
        codec,
        outboundBufferLimit: { ...limit, maxBytes: 2 * frameBytes },
        heartbeatIntervalMs: 10000,
      },
    });
    let signal: AbortSignal | undefined;
    let cleaned = 0;
    let escaped: unknown;
    const services = {
      test: createServiceSchema().define({
        stream: Procedure.stream({
          requestInit: Type.Object({}),
          requestData: Type.String(),
          responseData: Type.String(),
          handler: async ({ ctx, resWritable }) => {
            signal = ctx.signal;
            ctx.deferCleanup(() => {
              cleaned++;
            });
            try {
              resWritable.write(Ok('one'));
              resWritable.write(Ok('two'));
              if (terminal === 'close') resWritable.close();
              else ctx.cancel();
            } catch (error) {
              escaped = error;
            }
          },
        }),
      }),
    };
    const server = createServer(serverTransport, services);
    cleanups.push(() => server.close());
    const client = createClient<typeof services>(
      clientTransport,
      serverTransport.clientId,
    );
    const call = client.test.stream.stream({});
    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(cleaned).toBe(1);
    expect(escaped).toBeInstanceOf(Error);
    expect(server.streams.size).toBe(0);
    expect(await readNextResult(call.resReadable)).toEqual(Ok('one'));
    expect(await readNextResult(call.resReadable)).toEqual(Ok('two'));
    expect(await readNextResult(call.resReadable)).toMatchObject({
      ok: false,
      payload: { code: UNEXPECTED_DISCONNECT_CODE },
    });
  },
);

test.each(['heartbeat', 'rehandshake'] as const)(
  '%s overflow closes only the full session',
  async (control) => {
    const { codec } = pooledCodec();
    const { clientTransport, serverTransport } = await start({
      client: { heartbeatIntervalMs: 10000 },
      server: {
        codec,
        outboundBufferLimit: { ...limit, maxBytes: frameBytes },
        heartbeatIntervalMs: 10000,
      },
    });
    assert(setup);
    const healthy = setup.getClientTransport('healthy');
    cleanups.unshift(() => healthy.close());
    clientTransport.reconnectOnConnectionDrop = false;
    healthy.connect(serverTransport.clientId);
    clientTransport.connect(serverTransport.clientId);
    await waitFor(() => {
      expect(
        clientTransport.sessions.get(serverTransport.clientId)?.state,
      ).toBe(SessionState.Connected);
      expect(healthy.sessions.get(serverTransport.clientId)?.state).toBe(
        SessionState.Connected,
      );
    });
    const session = serverTransport.sessions.get('client');
    const other = serverTransport.sessions.get('healthy');
    assert(
      session?.state === SessionState.Connected &&
        other?.state === SessionState.Connected,
    );
    const history = session.sendBuffer;
    const counter = session.outboundBuffer;
    session.send({ streamId: 'full', controlFlags: 0, payload: {} });
    if (control === 'rehandshake') {
      expect(serverTransport.requestRehandshake('client')).toBe(false);
    } else {
      expect(() => vi.advanceTimersByTime(10000)).not.toThrow();
    }
    expect(counter).toEqual({ bytes: 0, overflowed: true });
    expect(history).toHaveLength(0);
    expect(serverTransport.sessions.has('client')).toBe(false);
    expect(serverTransport.sessions.get('healthy')?.id).toBe(other.id);
    await waitFor(() => expect(other.sendBuffer).toHaveLength(0));
    const seq = other.seq;
    expect(
      other.send({ streamId: 'healthy', controlFlags: 0, payload: {} }).ok,
    ).toBe(true);
    await waitFor(() =>
      expect(healthy.sessions.get(serverTransport.clientId)?.ack).toBe(seq + 1),
    );
  },
);

test('the entire limit is required and WebSocket close details are validated at construction', () => {
  expectTypeOf<SessionBoundSendFn>().returns.toEqualTypeOf<string>();
  const create = (
    outboundBufferLimit: TransportOptions['outboundBufferLimit'],
  ) =>
    new WebSocketClientTransport(
      () => Promise.reject(new Error('unused')),
      'client',
      { outboundBufferLimit },
    );
  for (const maxBytes of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => create({ ...limit, maxBytes })).toThrow('maxBytes');
  }
  for (const closeCode of [
    1001, 1004, 1005, 1006, 1013, 1015, 2000, 5000, 4000.5,
  ]) {
    expect(() => create({ ...limit, closeCode })).toThrow('closeCode');
  }
  for (const closeReason of ['x'.repeat(124), '\u00e9'.repeat(62), '\ud800']) {
    expect(() => create({ ...limit, closeReason })).toThrow('closeReason');
  }
  // @ts-expect-error All fields are required when the limit is enabled.
  expect(() => create({ maxBytes: 1 })).toThrow('closeCode');
  create({ ...limit, closeReason: 'x'.repeat(123) }).close();
  create({ ...limit, closeReason: '\u{1f600}' }).close();
  create(undefined).close();
});
