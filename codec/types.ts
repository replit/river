/**
 * Codec interface for encoding and decoding objects to and from string buffers.
 * Used to prepare messages for use by the transport layer.
 */
export interface Codec {
  /**
   * Encodes an object to a string buffer.
   * @param obj - The object to encode.
   * @returns The encoded string buffer.
   */
  toStringBuf(obj: object): string;
  /**
   * Decodes an object from a string buffer.
   * @param buf - The string buffer to decode.
   * @returns The decoded object, or null if decoding failed.
   */
  fromStringBuf(buf: string): object | null;
}
