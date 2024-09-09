import { describe, expect, test } from 'vitest';
import { duplexPair } from './duplexPair';

describe('duplexPair', () => {
  test('should create a pair of duplex streams', () => {
    const [a, b] = duplexPair();
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    a.write(Uint8Array.from([0x00, 0x01, 0x02]));
    expect(b.read()).toStrictEqual(Buffer.from([0x00, 0x01, 0x02]));

    b.write(Uint8Array.from([0x03, 0x04, 0x05]));
    expect(a.read()).toStrictEqual(Buffer.from([0x03, 0x04, 0x05]));
  });
});
