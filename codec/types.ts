export interface Codec {
  toStringBuf(obj: object): string;
  fromStringBuf(buf: string): object;
}
