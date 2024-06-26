import { BinaryCodec, Codec } from '../../codec';

export type ValidCodecs = 'binary';
export const codecs: Array<{
  name: ValidCodecs;
  codec: Codec;
}> = [{ name: 'binary', codec: BinaryCodec }];
