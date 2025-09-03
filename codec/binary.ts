import { DecodeError, ExtensionCodec, decode, encode } from '@msgpack/msgpack';
import { Codec } from './types';

const BIGINT_EXT_TYPE = 0;
const extensionCodec = new ExtensionCodec();
extensionCodec.register({
  type: BIGINT_EXT_TYPE,
  encode(input: unknown): Uint8Array | null {
    if (typeof input === 'bigint') {
      if (
        input <= Number.MAX_SAFE_INTEGER &&
        input >= Number.MIN_SAFE_INTEGER
      ) {
        return encode(Number(input));
      } else {
        return encode(String(input));
      }
    } else {
      return null;
    }
  },
  decode(data: Uint8Array): bigint {
    const val = decode(data);
    if (!(typeof val === 'string' || typeof val === 'number')) {
      throw new DecodeError(`unexpected BigInt source: ${typeof val}`);
    }

    return BigInt(val);
  },
});

/**
 * Binary codec, uses [msgpack](https://www.npmjs.com/package/@msgpack/msgpack) under the hood
 * @type {Codec}
 */
export const BinaryCodec: Codec = {
  toBuffer(obj) {
    return encode(obj, { ignoreUndefined: true, extensionCodec });
  },
  fromBuffer: (buff: Uint8Array) => {
    const res = decode(buff, { extensionCodec });
    if (typeof res !== 'object' || res === null) {
      throw new Error('unpacked msg is not an object');
    }

    return res;
  },
};
