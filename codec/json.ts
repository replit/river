import { Codec } from './types';

/**
 * Naive JSON codec implementation using JSON.stringify and JSON.parse.
 * @type {Codec}
 */
export const NaiveJsonCodec: Codec = {
  toStringBuf: JSON.stringify,
  fromStringBuf: (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  },
};
