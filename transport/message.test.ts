import { ack, msg, reply } from './message';
import { describe, test, expect } from 'vitest';

describe('message helpers', () => {
  test('ack', () => {
    const m = msg('a', 'b', 'svc', 'proc', { test: 1 });
    const resp = ack(m);
    expect(resp.from).toBe('b');
    expect(resp).toHaveProperty('ack');
  });

  test('reply', () => {
    const m = msg('a', 'b', 'svc', 'proc', { test: 1 });
    const payload = { cool: 2 };
    const resp = reply(m, payload);
    expect(resp.id).not.toBe(m.id);
    expect(resp.payload).toEqual(payload);
    expect(resp.from).toBe('b');
    expect(resp.to).toBe('a');
  });
});
