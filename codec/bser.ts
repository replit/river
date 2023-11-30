import { Codec } from './types';

const typeFlags = {
  array: 0x00,    // followed by an int containing number of items, each item is decoded in order
  object: 0x01,   // followed by an int containing number of items, each item is decoded in order
  string: 0x02,   // followed by an length of string in bytes
  int8: 0x03,     // followed by 1 byte of data
  int16: 0x04,    // followed by 2 bytes of data 
  int32: 0x05,    // followed by 4 bytes of data
  int64: 0x06,    // followed by 8 bytes of data
  real: 0x07,     // followed by 8 bytes of data
  boolT: 0x08,    // boolean true 
  boolF: 0x09,    // boolean false 
  null: 0x0a,     // null 
  template: 0x0b, // compact array of objects
  templateMissing: 0x0c
}


function encodeObject(obj: object): string {

}

/**
 * Binary JSON codec implementation inspired by [bser](https://facebook.github.io/watchman/docs/bser.html)
 * @type {Codec}
 */
export const BinaryCodec: Codec = {
  toStringBuf: encodeObject,
  fromStringBuf: (s: string) => {
  },
};
