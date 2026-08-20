import { TransportMessage } from '.';
import {
  ControlMessageHandshakeResponseSchema,
  ControlFlags,
  HandshakeErrorResponseCodes,
  handshakeRequestMessage,
  handshakeResponseMessage,
  isAck,
  isStreamClose,
  isStreamOpen,
} from './message';
import { describe, test, expect } from 'vitest';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

const msg = (
  to: string,
  from: string,
  streamId: string,
  payload: unknown,
  serviceName: string,
  procedureName: string,
): TransportMessage => ({
  id: 'abc',
  to,
  from,
  streamId,
  payload,
  serviceName,
  procedureName,
  controlFlags: 0,
  seq: 0,
  ack: 0,
});

describe('message helpers', () => {
  test('ack', () => {
    const m = msg('a', 'b', 'stream', { test: 1 }, 'svc', 'proc');
    m.controlFlags |= ControlFlags.AckBit;

    expect(isAck(m.controlFlags)).toBe(true);
    expect(isStreamOpen(m.controlFlags)).toBe(false);
    expect(isStreamClose(m.controlFlags)).toBe(false);
  });

  test('streamOpen', () => {
    const m = msg('a', 'b', 'stream', { test: 1 }, 'svc', 'proc');
    m.controlFlags |= ControlFlags.StreamOpenBit;

    expect(isAck(m.controlFlags)).toBe(false);
    expect(isStreamOpen(m.controlFlags)).toBe(true);
    expect(isStreamClose(m.controlFlags)).toBe(false);
  });

  test('streamClose', () => {
    const m = msg('a', 'b', 'stream', { test: 1 }, 'svc', 'proc');
    m.controlFlags |= ControlFlags.StreamClosedBit;

    expect(isAck(m.controlFlags)).toBe(false);
    expect(isStreamOpen(m.controlFlags)).toBe(false);
    expect(isStreamClose(m.controlFlags)).toBe(true);
  });

  test('handshakeRequestMessage', () => {
    const m = handshakeRequestMessage({
      from: 'a',
      to: 'b',
      expectedSessionState: {
        nextExpectedSeq: 0,
        nextSentSeq: 0,
      },
      sessionId: 'sess',
    });

    expect(m).toMatchObject({
      from: 'a',
      to: 'b',
      payload: {
        sessionId: 'sess',
      },
    });
  });

  test('handshakeResponseMessage', () => {
    const mSuccess = handshakeResponseMessage({
      from: 'a',
      to: 'b',
      status: {
        ok: true,
        sessionId: 'sess',
      },
    });
    const mFail = handshakeResponseMessage({
      from: 'a',
      to: 'b',
      status: {
        ok: false,
        reason: 'bad',
        code: 'SESSION_STATE_MISMATCH',
      },
    });

    expect(mSuccess.from).toBe('a');
    expect(mSuccess.to).toBe('b');
    expect(mSuccess.payload.status.ok).toBe(true);

    expect(mFail.from).toBe('a');
    expect(mFail.to).toBe('b');
    expect(mFail.payload.status.ok).toBe(false);
  });

  test('structured handshake rejections are compatible with older clients', () => {
    const oldHandshakeResponseSchema = Type.Object({
      type: Type.Literal('HANDSHAKE_RESP'),
      status: Type.Union([
        Type.Object({
          ok: Type.Literal(true),
          sessionId: Type.String(),
        }),
        Type.Object({
          ok: Type.Literal(false),
          reason: Type.String(),
          code: HandshakeErrorResponseCodes,
        }),
      ]),
    });
    const payload = {
      type: 'HANDSHAKE_RESP',
      status: {
        ok: false,
        reason: 'rejected by handshake handler',
        code: 'REJECTED_BY_CUSTOM_HANDLER',
        details: {
          code: 'TOKEN_EXPIRED',
          message: 'The authentication token expired',
        },
      },
    };

    expect(Value.Check(oldHandshakeResponseSchema, payload)).toBe(true);
    expect(Value.Check(ControlMessageHandshakeResponseSchema, payload)).toBe(
      true,
    );
  });

  test('handshake rejections without details remain valid', () => {
    expect(
      Value.Check(ControlMessageHandshakeResponseSchema, {
        type: 'HANDSHAKE_RESP',
        status: {
          ok: false,
          reason: 'rejected by handshake handler',
          code: 'REJECTED_BY_CUSTOM_HANDLER',
        },
      }),
    ).toBe(true);
  });

  test('default message has no control flags set', () => {
    const m = msg('a', 'b', 'stream', { test: 1 }, 'svc', 'proc');

    expect(isAck(m.controlFlags)).toBe(false);
    expect(isStreamOpen(m.controlFlags)).toBe(false);
    expect(isStreamClose(m.controlFlags)).toBe(false);
  });

  test('combining control flags works', () => {
    const m = msg('a', 'b', 'stream', { test: 1 }, 'svc', 'proc');
    m.controlFlags |= ControlFlags.StreamOpenBit;

    expect(isStreamOpen(m.controlFlags)).toBe(true);
    expect(isStreamClose(m.controlFlags)).toBe(false);

    m.controlFlags |= ControlFlags.StreamClosedBit;
    expect(isStreamOpen(m.controlFlags)).toBe(true);
    expect(isStreamClose(m.controlFlags)).toBe(true);
  });
});
