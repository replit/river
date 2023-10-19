import { Codec } from './types';

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
