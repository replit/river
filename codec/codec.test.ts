import { NaiveJsonCodec } from './json';
import { describe, test, expect } from 'vitest';

describe('naive json codec', () => {
  test('empty object', () => {
    const msg = {};
    expect(
      NaiveJsonCodec.fromBuffer(NaiveJsonCodec.toBuffer(msg)),
    ).toStrictEqual(msg);
  });

  test('simple test', () => {
    const msg = { abc: 123, def: 'cool' };
    expect(
      NaiveJsonCodec.fromBuffer(NaiveJsonCodec.toBuffer(msg)),
    ).toStrictEqual(msg);
  });

  test('deeply nested test', () => {
    const msg = {
      array: [{ object: true }],
      buff: Uint8Array.from([0, 42, 100, 255]),
      deeply: {
        nested: {
          nice: null,
        },
      },
    };
    expect(
      NaiveJsonCodec.fromBuffer(NaiveJsonCodec.toBuffer(msg)),
    ).toStrictEqual(msg);
  });

  test('invalid json returns null', () => {
    const encoder = new TextEncoder();
    expect(NaiveJsonCodec.fromBuffer(encoder.encode(''))).toBeNull();
    expect(NaiveJsonCodec.fromBuffer(encoder.encode('['))).toBeNull();
    expect(NaiveJsonCodec.fromBuffer(encoder.encode('[{}'))).toBeNull();
    expect(NaiveJsonCodec.fromBuffer(encoder.encode('{"a":1}[]'))).toBeNull();
  });
});
