import { describe, test, expect } from 'vitest';
import { NaiveJsonCodec } from './json';
import { codecs } from '../testUtil/fixtures/codec';

const examples: Array<{
  name: string;
  obj: Record<string, unknown>;
  expected?: Record<string, unknown>;
}> = [
  { name: 'empty object', obj: {} },
  { name: 'simple object', obj: { abc: 123, def: 'cool' } },
  { name: 'non-utf8 string', obj: { test: '🇧🇪你好世界' } },
  { name: 'null value', obj: { test: null } },
  { name: 'empty buffer', obj: { test: new Uint8Array(0) } },
  { name: 'optional field', obj: { test: undefined }, expected: {} },
  {
    name: 'bigint value',
    obj: { big: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1) },
  },
  {
    name: 'deeply nested',
    obj: {
      array: [{ object: true }],
      deeply: {
        nested: {
          nice: null,
        },
      },
    },
  },
  {
    name: 'buffer test',
    obj: {
      buff: Uint8Array.from([0, 42, 100, 255]),
    },
  },
];

describe.each(codecs)('codec -- $name', ({ codec }) => {
  describe.each(examples)('example -- $name', ({ obj, expected }) => {
    test('encodes and decodes correctly', () => {
      expect(codec.fromBuffer(codec.toBuffer(obj))).toStrictEqual(
        expected ?? obj,
      );
    });
  });

  test('invalid json throws', () => {
    expect(() => codec.fromBuffer(Buffer.from(''))).toThrow();
    expect(() => codec.fromBuffer(Buffer.from('['))).toThrow();
    expect(() => codec.fromBuffer(Buffer.from('[{}'))).toThrow();
    expect(() => codec.fromBuffer(Buffer.from('{"a":1}[]'))).toThrow();
  });
});


describe('NaiveJsonCodec marker key escaping', () => {
  test('preserves an own __proto__ key while encoding marker-like keys', () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"$t":"application data"}',
    ) as Record<string, unknown>;

    const decoded = NaiveJsonCodec.fromBuffer(NaiveJsonCodec.toBuffer(input));

    expect(Object.prototype.hasOwnProperty.call(decoded, '__proto__')).toBe(
      true,
    );
    expect(decoded).toStrictEqual(input);
  });

  test('preserves an own __proto__ key while decoding escaped marker keys', () => {
    const encoded = Buffer.from(
      '{"__proto__":{"polluted":true},"$$t":"application data"}',
    );
    const expected = JSON.parse(
      '{"__proto__":{"polluted":true},"$t":"application data"}',
    );

    const decoded = NaiveJsonCodec.fromBuffer(encoded);

    expect(Object.prototype.hasOwnProperty.call(decoded, '__proto__')).toBe(
      true,
    );
    expect(decoded).toStrictEqual(expected);
  });
});
