import { Codec } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * JSON can't represent a Uint8Array or a bigint, so this codec encodes them as
 * single-key marker objects: `{ $t: <base64> }` and `{ $b: <digits> }`.
 *
 * That puts the markers in the same namespace as application data, so a payload
 * that happens to use those keys is ambiguous. To keep the round-trip faithful,
 * any key that could be mistaken for a marker gains an extra `$` on the way out
 * and loses it on the way back in.
 *
 * Note this only holds when both peers escape. Against an older peer, a payload
 * key of `$t`/`$b` behaves as it did before: `$t` decodes as binary, and `$b`
 * with a non-numeric value is rejected as a malformed message.
 */
const MARKER_BINARY = '$t';
const MARKER_BIGINT = '$b';
/** `$t`, `$$t`, `$b`, `$$$b`, ... -- anything that unescapes toward a marker. */
const AMBIGUOUS_KEY = /^\$+[tb]$/;
const DOLLAR = '$'.charCodeAt(0);
/** What `bigint.toString()` can produce, so a marker is never a guess. */
const BIGINT_DIGITS = /^-?\d+$/;

/**
 * `btoa`/`atob` dominate base64 conversion, and building the intermediate
 * binary string a character at a time makes it worse -- on a 64KB payload that
 * combination cost ~1.4ms per direction. Node's Buffer does the same work in
 * single-digit microseconds, so use it where it exists and keep a chunked
 * `btoa` path for browsers.
 */
const hasBuffer = typeof Buffer !== 'undefined';
// how many bytes to hand String.fromCharCode at once without risking the stack
const FROM_CHAR_CODE_CHUNK = 0x8000;

// Convert Uint8Array to base64
function uint8ArrayToBase64(uint8Array: Uint8Array) {
  if (hasBuffer) {
    return Buffer.from(
      uint8Array.buffer,
      uint8Array.byteOffset,
      uint8Array.byteLength,
    ).toString('base64');
  }

  let binary = '';
  for (let i = 0; i < uint8Array.length; i += FROM_CHAR_CODE_CHUNK) {
    binary += String.fromCharCode(
      ...uint8Array.subarray(i, i + FROM_CHAR_CODE_CHUNK),
    );
  }

  return btoa(binary);
}

// Convert base64 to Uint8Array
function base64ToUint8Array(base64: string) {
  if (hasBuffer) {
    const buf = Buffer.from(base64, 'base64');

    // a view, not a copy -- but typed as Uint8Array rather than Buffer, since
    // callers (and deep-equality in tests) distinguish the two by prototype
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

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

interface BigIntEncodedValue {
  $b: string;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isAmbiguous(key: string): boolean {
  // the charCode guard keeps the regex off the hot path for ordinary keys
  return key.charCodeAt(0) === DOLLAR && AMBIGUOUS_KEY.test(key);
}

/** An already-escaped key, i.e. two or more `$` before the marker letter. */
function isEscaped(key: string): boolean {
  return key.length > 2 && isAmbiguous(key);
}

function isOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// for-in rather than Object.keys: these run per object on both hot paths, and
// Object.keys allocates an array every time
function someKey(
  obj: Record<string, unknown>,
  predicate: (key: string) => boolean,
): boolean {
  for (const key in obj) {
    if (isOwn(obj, key) && predicate(key)) return true;
  }

  return false;
}

/** The single own key of `obj`, or undefined if it doesn't have exactly one. */
function soleKey(obj: Record<string, unknown>): string | undefined {
  let only: string | undefined;
  for (const key in obj) {
    if (!isOwn(obj, key)) continue;
    if (only !== undefined) return undefined;
    only = key;
  }

  return only;
}

function rekey(
  obj: Record<string, unknown>,
  rename: (key: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    out[rename(key)] = obj[key];
  }

  return out;
}

/**
 * Decodes a marker object, or returns undefined if this isn't one. Markers we
 * write always have exactly one key and a well-formed value, so anything else
 * is application data that happens to look similar.
 */
function decodeMarker(val: Record<string, unknown>): unknown {
  const key = soleKey(val);
  if (key === undefined) return undefined;

  const encoded = val[key];
  if (typeof encoded !== 'string') return undefined;

  if (key === MARKER_BINARY) {
    try {
      return base64ToUint8Array(encoded);
    } catch {
      return undefined;
    }
  }

  if (key === MARKER_BIGINT && BIGINT_DIGITS.test(encoded)) {
    return BigInt(encoded);
  }

  return undefined;
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
        } else if (typeof val === 'bigint') {
          return { $b: val.toString() } satisfies BigIntEncodedValue;
        } else if (isPlainObject(val) && someKey(val, isAmbiguous)) {
          // returning a copy is what renames the keys: stringify recurses into
          // what the replacer hands back. markers we just built never come
          // through here, so they are never double-escaped.
          return rekey(val, (k) => (isAmbiguous(k) ? `$${k}` : k));
        } else {
          return val;
        }
      }),
    );
  },
  fromBuffer: (buff: Uint8Array) => {
    const parsed = JSON.parse(
      decoder.decode(buff),
      function reviver(_key, val: unknown) {
        if (!isPlainObject(val)) return val;

        const marker = decodeMarker(val);
        if (marker !== undefined) return marker;

        return someKey(val, isEscaped)
          ? rekey(val, (k) => (isEscaped(k) ? k.slice(1) : k))
          : val;
      },
    ) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('unpacked msg is not an object');
    }

    return parsed;
  },
};
