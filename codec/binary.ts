import { Packr } from 'msgpackr';
import { Codec } from './types';

const packr = new Packr({
  useRecords: false,
  moreTypes: true,
  bundleStrings: true,
  useTimestamp32: false,
  useBigIntExtension: true,
  skipValues: [undefined],
});

/**
 * Binary codec, uses [msgpackr](https://www.npmjs.com/package/msgpackr) under the hood
 * @type {Codec}
 */
export const BinaryCodec: Codec = {
  toBuffer(obj) {
    return packr.pack(obj);
  },
  fromBuffer: (buff: Uint8Array) => {
    const res = packr.unpack(buff);
    if (typeof res !== 'object' || res === null) {
      throw new Error('unpacked msg is not an object');
    }

    return res;
  },
};
