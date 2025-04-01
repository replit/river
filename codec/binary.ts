import { decode, encode } from '@msgpack/msgpack';
import { Codec } from './types';

/**
 * Binary codec, uses [msgpack](https://www.npmjs.com/package/@msgpack/msgpack) under the hood
 * @type {Codec}
 */
export const BinaryCodec: Codec = {
  toBuffer(obj) {
    return encode(obj, { ignoreUndefined: true });
  },
  fromBuffer: (buff: Uint8Array) => {
    const res = decode(buff);
    if (typeof res !== 'object' || res === null) {
      throw new Error('unpacked msg is not an object');
    }

    return res;
  },
};
