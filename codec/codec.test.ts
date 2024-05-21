import { describe, test, expect } from 'vitest';
import { codecs } from '../__tests__/fixtures/codec';

describe.each(codecs)('codec -- $name', ({ codec }) => {
  test('empty object', () => {
    const msg = {};
    expect(codec.fromBuffer(codec.toBuffer(msg))).toStrictEqual(msg);
  });

  test('simple test', () => {
    const msg = { abc: 123, def: 'cool' };
    expect(codec.fromBuffer(codec.toBuffer(msg))).toStrictEqual(msg);
  });

  test('encodes null properly', () => {
    const msg = { test: null };
    expect(codec.fromBuffer(codec.toBuffer(msg))).toStrictEqual(msg);
  });

  test('skips optional fields', () => {
    const msg = { test: undefined };
    expect(codec.fromBuffer(codec.toBuffer(msg))).toStrictEqual({});
  });

  test('deeply nested test', () => {
    const msg = {
      array: [{ object: true }],
      deeply: {
        nested: {
          nice: null,
        },
      },
    };
    expect(codec.fromBuffer(codec.toBuffer(msg))).toStrictEqual(msg);
  });

  test('buffer test', () => {
    const msg = {
      buff: Uint8Array.from([0, 42, 100, 255]),
    };
    expect(codec.fromBuffer(codec.toBuffer(msg))).toStrictEqual(msg);
  });

  test('invalid json returns null', () => {
    expect(codec.fromBuffer(Buffer.from(''))).toBeNull();
    expect(codec.fromBuffer(Buffer.from('['))).toBeNull();
    expect(codec.fromBuffer(Buffer.from('[{}'))).toBeNull();
    expect(codec.fromBuffer(Buffer.from('{"a":1}[]'))).toBeNull();
  });
});
