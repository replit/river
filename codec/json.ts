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

interface Base64EncodedValue {
  $t: string;
}

/**
 * Naive JSON codec implementation using JSON.stringify and JSON.parse.
 * @type {Codec}
 */
export const NaiveJsonCodec: Codec = {
  toBuffer: (obj: object) => {
    return encoder.encode(
      JSON.stringify(obj, function replacer<
        T extends object,
      >(this: T, key: keyof T) {
        const val = this[key];
        if (val instanceof Uint8Array) {
          return { $t: uint8ArrayToBase64(val) } satisfies Base64EncodedValue;
        } else {
          return val;
        }
      }),
    );
  },
  fromBuffer: (buff: Uint8Array) => {
    try {
      const parsed = JSON.parse(
        decoder.decode(buff),
        function reviver(_key, val: unknown) {
          if ((val as Base64EncodedValue | undefined)?.$t) {
            return base64ToUint8Array((val as Base64EncodedValue).$t);
          } else {
            return val;
          }
        },
      ) as unknown;

      if (typeof parsed === 'object') return parsed;

      return null;
    } catch {
      return null;
    }
  },
};
