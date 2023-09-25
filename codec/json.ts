import { Codec } from './types';

export const NaiveJsonCodec: Codec = {
  toStringBuf: JSON.stringify,
  fromStringBuf: JSON.parse,
};
