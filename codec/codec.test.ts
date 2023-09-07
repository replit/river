import { NaiveJsonCodec } from './json';
import { describe, test, expect } from 'vitest';

describe('naive json codec', () => {
  test('empty object', () => {
    const msg = {};
    expect(NaiveJsonCodec.fromStringBuf(NaiveJsonCodec.toStringBuf(msg))).toStrictEqual(msg);
  });

  test('simple test', () => {
    const msg = { abc: 123, def: 'cool' };
    expect(NaiveJsonCodec.fromStringBuf(NaiveJsonCodec.toStringBuf(msg))).toStrictEqual(msg);
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
    expect(NaiveJsonCodec.fromStringBuf(NaiveJsonCodec.toStringBuf(msg))).toStrictEqual(msg);
  });
});
