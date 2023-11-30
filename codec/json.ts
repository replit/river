import { Codec } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Convert Uint8Array to base64
function uint8ArrayToBase64(uint8Array: Uint8Array) {
  let binary = '';
  uint8Array.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

// Convert base64 to Uint8Array
function base64ToUint8Array(base64: string) {
  const binaryString = atob(base64);
  const uint8Array = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    uint8Array[i] = binaryString.charCodeAt(i);
  }
  return uint8Array;
}

/**
 * Naive JSON codec implementation using JSON.stringify and JSON.parse.
 * @type {Codec}
 */
export const NaiveJsonCodec: Codec = {
  toBuffer: (obj: object) => {
    return encoder.encode(JSON.stringify(obj, function replacer(key) {
      let val = this[key]
      if (val instanceof Uint8Array) {
        return { $t: uint8ArrayToBase64(val) }
      } else {
        return val
      }
    }));
  },
  fromBuffer: (s: Uint8Array) => {
    try {
      return JSON.parse(decoder.decode(s), function reviver(_key, val) {
        if (val?.$t) {
          return base64ToUint8Array(val.$t)
        } else {
          return val
        }
      });
    } catch {
      return null;
    }
  },
};
