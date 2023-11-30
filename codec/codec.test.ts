import { BinaryCodec } from './binary';
import { NaiveJsonCodec } from './json';
import { describe, test, expect } from 'vitest';

describe.each([
  { name: 'naive', codec: NaiveJsonCodec },
  { name: 'binary', codec: BinaryCodec },
])('codec -- $name', ({ codec }) => {
  test('empty object', () => {
    const msg = {};
    expect(codec.fromBuffer(codec.toBuffer(msg))).toStrictEqual(msg);
  });

  test('simple test', () => {
    const msg = { abc: 123, def: 'cool' };
    expect(codec.fromBuffer(codec.toBuffer(msg))).toStrictEqual(msg);
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
    expect(codec.fromBuffer(codec.toBuffer(msg))).toStrictEqual(msg);
  });

  test('invalid json returns null', () => {
    const encoder = new TextEncoder();
    expect(codec.fromBuffer(encoder.encode(''))).toBeNull();
    expect(codec.fromBuffer(encoder.encode('['))).toBeNull();
    expect(codec.fromBuffer(encoder.encode('[{}'))).toBeNull();
    expect(codec.fromBuffer(encoder.encode('{"a":1}[]'))).toBeNull();
  });
});
