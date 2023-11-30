import { decode, encode } from '@msgpack/msgpack';
import { Codec } from './types';

/**
 * Binary codec, uses [msgpack](https://www.npmjs.com/package/@msgpack/msgpack) under the hood
 * @type {Codec}
 */
export const BinaryCodec: Codec = {
  toBuffer: encode,
  fromBuffer: (buff: Uint8Array) => {
    try {
      const res = decode(buff)
      if (typeof res !== 'object') {
        return null
      }

      return res;
    } catch {
      return null;
    }
  },
};
