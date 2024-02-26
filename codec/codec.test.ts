import { Codec } from '.';
import { BinaryCodec } from './binary';
import { NaiveJsonCodec } from './json';
import { describe, test, expect } from 'vitest';

export const codecs: Array<{
  name: string;
  codec: Codec;
}> = [
  { name: 'naive', codec: NaiveJsonCodec },
  { name: 'binary', codec: BinaryCodec },
];

describe.each(codecs)('codec -- $name', ({ codec }) => {
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
