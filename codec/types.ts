/**
 * Codec interface for encoding and decoding objects to and from Uint8 buffers.
 * Used to prepare messages for use by the transport layer.
 */
export interface Codec {
  /**
   * Encodes an object to a Uint8 buffer.
   * @param obj - The object to encode.
   * @returns The encoded Uint8 buffer.
   */
  toBuffer(obj: object): Uint8Array;
  /**
   * Decodes an object from a Uint8 buffer.
   * @param buf - The Uint8 buffer to decode.
   * @returns The decoded object, or null if decoding failed.
   */
  fromBuffer(buf: Uint8Array): object | null;
}
