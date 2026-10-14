import { afterEach, describe, expect, test, vi } from 'vitest';
import { CodecMessageAdapter } from '../../codec';
import { createSessionTelemetryInfo, getTracer } from '../../tracing';
import { Connection } from '../connection';
import { ControlFlags, currentProtocolVersion } from '../message';
import { defaultTransportOptions, ProvidedTransportOptions } from '../options';
import { SessionConnected } from './SessionConnected';
import { SessionStateGraph } from './transitions';

class RecordingConnection extends Connection {
  send = vi.fn(() => true);
  close = vi.fn();
}

function connected(options: ProvidedTransportOptions = {}) {
  const conn = new RecordingConnection();
  const tracer = getTracer();
  const session = new SessionConnected({
    from: 'receiver',
    to: 'sender',
    id: 'session',
    seq: 0,
    seqSent: 0,
    ack: 0,
    sendBuffer: [],
    sendBufferDrainWaiter: undefined,
    options: { ...defaultTransportOptions, ...options },
    codec: new CodecMessageAdapter(defaultTransportOptions.codec),
    protocolVersion: currentProtocolVersion,
    tracer,
    log: undefined,
    telemetry: createSessionTelemetryInfo(
      tracer,
      'session',
      'sender',
      'receiver',
    ),
    conn,
    listeners: {
      onMessage: vi.fn(),
      onRehandshake: vi.fn(),
      onConnectionErrored: vi.fn(),
      onConnectionClosed: vi.fn(),
      onInvalidMessage: vi.fn(),
      onMessageSendFailure: vi.fn(),
    },
  });
  const receive = (controlFlags = 0, ack = 0) => {
    const data = session.codec.toBuffer({
      id: `inbound-${session.ack}`,
      from: 'sender',
      to: 'receiver',
      streamId: controlFlags ? 'heartbeat' : 'data',
      controlFlags,
      payload: controlFlags ? { type: 'ACK' } : {},
      seq: session.ack,
      ack,
    });
    if (!data.ok) throw new Error(data.reason);
    session.onMessageData(data.value);
  };

  return { session, conn, receive };
}

afterEach(() => vi.clearAllTimers());

describe('receiver-driven ACKs', () => {
  test('count threshold sends a cumulative ACK without waiting for a heartbeat', () => {
    const { session, conn, receive } = connected({
      receiverAck: { maxMessages: 3, maxDelayMs: 50 },
    });
    receive();
    receive();
    expect(conn.send).not.toHaveBeenCalled();
    receive();
    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(session.sendBuffer[0].msg).toMatchObject({
      streamId: 'heartbeat',
      controlFlags: ControlFlags.AckBit,
      payload: { type: 'ACK' },
    });
    expect(session.codec.fromBuffer(session.sendBuffer[0].data)).toMatchObject({
      ok: true,
      value: { ack: 3 },
    });
    vi.advanceTimersByTime(50);
    expect(conn.send).toHaveBeenCalledTimes(1);
    session._handleClose();
  });

  test('delay is bounded from the first message, not reset by later arrivals', () => {
    const { session, conn, receive } = connected({
      receiverAck: { maxMessages: 10, maxDelayMs: 50 },
    });
    receive();
    vi.advanceTimersByTime(40);
    receive();
    vi.advanceTimersByTime(10);
    expect(conn.send).toHaveBeenCalledTimes(1);
    session._handleClose();
  });

  test('piggybacking cancels a batch and connected-state exit cancels its timer', () => {
    const { session, conn, receive } = connected({
      receiverAck: { maxMessages: 10, maxDelayMs: 50 },
    });
    receive();
    session.send({ streamId: 'reply', controlFlags: 0, payload: {} });
    vi.advanceTimersByTime(50);
    expect(conn.send).toHaveBeenCalledTimes(1);
    receive();
    session._handleStateExit();
    vi.advanceTimersByTime(50);
    expect(conn.send).toHaveBeenCalledTimes(1);
    session._handleClose();
  });

  test('ACKs do not arm batches; default mode does not send unsolicited ACKs', () => {
    const enabled = connected({
      receiverAck: { maxMessages: 1, maxDelayMs: 50 },
    });
    enabled.session.startActiveHeartbeat();
    enabled.receive(ControlFlags.AckBit);
    vi.advanceTimersByTime(50);
    expect(enabled.conn.send).not.toHaveBeenCalled();
    enabled.session._handleClose();

    const disabled = connected();
    disabled.receive();
    vi.advanceTimersByTime(50);
    expect(disabled.conn.send).not.toHaveBeenCalled();
    disabled.session._handleClose();
  });

  test('inbound messages arriving during a synchronous send keep their ACK deadline', () => {
    const { session, conn, receive } = connected({
      receiverAck: { maxMessages: 10, maxDelayMs: 50 },
    });
    receive();
    conn.send.mockImplementationOnce(() => {
      receive();

      return true;
    });
    session.send({ streamId: 'reply', controlFlags: 0, payload: {} });
    vi.advanceTimersByTime(50);
    expect(conn.send).toHaveBeenCalledTimes(2);
    expect(session.codec.fromBuffer(session.sendBuffer[1].data)).toMatchObject({
      ok: true,
      value: { ack: 2 },
    });
    session._handleClose();
  });
});

test('stream waiters drain independently, survive state transitions, and settle on close', async () => {
  const { session, receive } = connected({
    sendBufferHighWaterMark: 2,
    streamSendBufferHighWaterMark: 2,
  });
  for (const streamId of ['light', 'light', 'heavy', 'heavy', 'heavy']) {
    session.send({ streamId, controlFlags: 0, payload: {} });
  }
  const lightReady = session.waitForSendBufferDrain('light');
  const heavyReady = session.waitForSendBufferDrain('heavy');
  let heavyDrained = false;
  void heavyReady.then(() => {
    heavyDrained = true;
  });
  receive(ControlFlags.AckBit, 2);
  await lightReady;
  expect(heavyDrained).toBe(false);
  expect(session.isSendBufferFull('light')).toBe(false);
  expect(session.isSendBufferFull('heavy')).toBe(true);
  const disconnected = SessionStateGraph.transition.ConnectedToNoConnection(
    session,
    { onSessionGracePeriodElapsed: vi.fn(), onMessageSendFailure: vi.fn() },
  );
  expect(disconnected.isSendBufferFull('heavy')).toBe(true);
  expect(disconnected.waitForSendBufferDrain('heavy')).toBe(heavyReady);
  disconnected._handleClose();
  await heavyReady;
});
