import {
  ControlFlags,
  isAck,
  isStreamClose,
  isStreamOpen,
  msg,
  reply,
} from './message';
import { describe, test, expect } from 'vitest';

describe('message helpers', () => {
  test('ack', () => {
    const m = msg('a', 'b', 'stream', { test: 1 }, 'svc', 'proc');
    m.controlFlags |= ControlFlags.AckBit;
    expect(m).toHaveProperty('controlFlags');
    expect(isAck(m.controlFlags)).toBe(true);
    expect(isStreamOpen(m.controlFlags)).toBe(false);
    expect(isStreamClose(m.controlFlags)).toBe(false);
  });

  test('streamOpen', () => {
    const m = msg('a', 'b', 'stream', { test: 1 }, 'svc', 'proc');
    m.controlFlags |= ControlFlags.StreamOpenBit;
    expect(m).toHaveProperty('controlFlags');
    expect(isAck(m.controlFlags)).toBe(false);
    expect(isStreamOpen(m.controlFlags)).toBe(true);
    expect(isStreamClose(m.controlFlags)).toBe(false);
  });

  test('streamClose', () => {
    const m = msg('a', 'b', 'stream', { test: 1 }, 'svc', 'proc');
    m.controlFlags |= ControlFlags.StreamClosedBit;
    expect(m).toHaveProperty('controlFlags');
    expect(isAck(m.controlFlags)).toBe(false);
    expect(isStreamOpen(m.controlFlags)).toBe(false);
    expect(isStreamClose(m.controlFlags)).toBe(true);
  });

  test('reply', () => {
    const m = msg('a', 'b', 'stream', { test: 1 }, 'svc', 'proc');
    const payload = { cool: 2 };
    const resp = reply(m, payload);
    expect(resp.id).not.toBe(m.id);
    expect(resp.payload).toEqual(payload);
    expect(resp.from).toBe('b');
    expect(resp.to).toBe('a');
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
