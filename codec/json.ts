import { Codec } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Naive JSON codec implementation using JSON.stringify and JSON.parse.
 * @type {Codec}
 */
export const NaiveJsonCodec: Codec = {
  toBuffer: (obj: object) => {
    return encoder.encode(JSON.stringify(obj));
  },
  fromBuffer: (s: Uint8Array) => {
    try {
      return JSON.parse(decoder.decode(s));
    } catch {
      return null;
    }
  },
};
