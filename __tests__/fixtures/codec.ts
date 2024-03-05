import { BinaryCodec, Codec, NaiveJsonCodec } from '../../codec';

export type ValidCodecs = 'naive' | 'binary';
export const codecs: Array<{
  name: ValidCodecs;
  codec: Codec;
}> = [
  { name: 'naive', codec: NaiveJsonCodec },
  { name: 'binary', codec: BinaryCodec },
];
