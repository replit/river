import { afterEach, assert, expect, test } from 'vitest';
import { NaiveJsonCodec } from '../codec';
import { transports } from '../testUtil/fixtures/transports';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import { generateId } from '../transport/id';
import { SessionState } from '../transport/sessionStateMachine';

const limit = { maxBytes: 4096, closeCode: 4008, closeReason: 'fixture full' };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.each([
  'created',
  'initial transition',
  'updated transition',
  'message',
] as const)(
  'foreign overflow in a %s observer propagates without ending the observed session',
  async (path) => {
    const ws = transports.find((entry) => entry.name === 'ws');
    assert(ws);
    const capped = path === 'updated transition' || path === 'message';
    const setup = await ws.setup({
      client: capped ? { outboundBufferLimit: limit } : {},
      server: { heartbeatIntervalMs: 10000 },
    });
    cleanups.push(() => setup.cleanup());
    const client = setup.getClientTransport('client');
    const server = setup.getServerTransport();
    client.reconnectOnConnectionDrop = false;
    cleanups.push(() => {
      client.close();
      server.close();
    });

    const foreign = new WebSocketClientTransport(
      () => Promise.reject(new Error('foreign transport must not dial')),
      'foreign',
      { outboundBufferLimit: { ...limit, maxBytes: 1 } },
    );
    cleanups.push(() => foreign.close());
    const foreignSession = foreign.createUnconnectedSession('peer');
    const foreignSend = foreign.getSessionBoundSendFn(
      'peer',
      foreignSession.id,
    );
    const frame = { streamId: 'probe', controlFlags: 0, payload: {} };
    let fail = () => {
      foreignSend(frame);
    };
    let secondObserverCalls = 0;
    let trigger: () => void;

    if (path === 'message') {
      client.connect(server.clientId);
      await waitFor(() =>
        expect(client.sessions.get(server.clientId)?.state).toBe(
          SessionState.Connected,
        ),
      );
      const receiver = client.sessions.get(server.clientId);
      assert(receiver?.state === SessionState.Connected);
      trigger = () =>
        receiver.conn.onData(
          NaiveJsonCodec.toBuffer({
            ...frame,
            id: generateId(),
            from: server.clientId,
            to: client.clientId,
            seq: receiver.ack,
            ack: 0,
          }),
        );
      client.addEventListener('message', () => fail());
      client.addEventListener('message', () => {
        secondObserverCalls++;
      });
    } else if (path === 'created') {
      client.addEventListener('sessionStatus', (event) => {
        if (event.status === 'created') fail();
      });
      client.addEventListener('sessionStatus', (event) => {
        if (event.status === 'created') secondObserverCalls++;
      });
      trigger = () => {
        client.createUnconnectedSession(server.clientId);
      };
    } else {
      if (path === 'updated transition')
        client.createUnconnectedSession(server.clientId);
      client.addEventListener('sessionTransition', () => fail());
      client.addEventListener('sessionTransition', () => {
        secondObserverCalls++;
      });
      trigger =
        path === 'initial transition'
          ? () => {
              client.createUnconnectedSession(server.clientId);
            }
          : () => client.connect(server.clientId);
    }

    expect(trigger).toThrow('outbound replay history limit exceeded');
    expect(foreign.sessions.size).toBe(0);
    const original = client.sessions.get(server.clientId);
    assert(original);
    expect(original._isConsumed).toBe(false);
    expect(original.outboundBuffer?.overflowed ?? false).toBe(false);
    expect(secondObserverCalls).toBe(0);

    if (path === 'created') {
      const ordinary = new Error('ordinary observer failure');
      fail = () => {
        throw ordinary;
      };
      expect(() => client.createUnconnectedSession('other-peer')).toThrow(
        ordinary,
      );
      expect(secondObserverCalls).toBe(0);
      expect(original._isConsumed).toBe(false);
    }

    if (path === 'message') {
      const outboundBuffer = original.outboundBuffer;
      assert(outboundBuffer);
      const send = client.getSessionBoundSendFn(server.clientId, original.id);
      client.addEventListener('sessionStatus', (event) => {
        if (event.status === 'closed' && event.session.id === original.id)
          client.createUnconnectedSession(server.clientId);
      });
      fail = () => {
        send({ ...frame, payload: 'x'.repeat(limit.maxBytes) });
      };
      expect(trigger).not.toThrow();
      expect(original._isConsumed).toBe(true);
      expect(outboundBuffer.overflowed).toBe(true);
      const replacement = client.sessions.get(server.clientId);
      expect(replacement?.id).not.toBe(original.id);
      expect(replacement?.outboundBuffer?.overflowed).toBe(false);
    }
  },
);
