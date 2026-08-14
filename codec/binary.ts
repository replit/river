import {
  DecodeError,
  Decoder,
  Encoder,
  ExtensionCodec,
  decode,
  encode,
} from '@msgpack/msgpack';
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
// msgpack's top-level encode/decode build a fresh Encoder/Decoder per call, and
// the Encoder constructor allocates a backing ArrayBuffer every time. Reusing
// one of each drops that per-message allocation. Both classes guard reentrancy
// by cloning themselves, so this stays correct under nested use, and
// Encoder.encode (unlike encodeSharedRef) returns a copy -- which the send
// buffer needs anyway, since it holds onto the bytes for retransmission.
const encoder = new Encoder({
  ignoreUndefined: true,
  initialBufferSize: 512,
  extensionCodec,
});
const decoder = new Decoder({ extensionCodec });

export const BinaryCodec: Codec = {
  toBuffer(obj) {
    return encoder.encode(obj);
  },
  fromBuffer: (buff: Uint8Array) => {
    const res = decoder.decode(buff);
    if (typeof res !== 'object' || res === null) {
      throw new Error('unpacked msg is not an object');
    }

    return res;
  },
};
