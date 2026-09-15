/**
 * Codec interface for encoding and decoding values to and from Uint8 buffers.
 * Used to prepare messages for use by the transport layer.
 */
export interface Codec<T = object, TInit = T> {
  /**
   * Encodes a value to a Uint8 buffer.
   * @param obj - The value to encode.
   * @returns The encoded Uint8 buffer.
   */
  toBuffer(obj: TInit): Uint8Array;
  /**
   * Decodes a value from a Uint8 buffer.
   * @param buf - The Uint8 buffer to decode.
   * @returns The decoded value. This can be null if T permits it.
   * @throws If decoding fails.
   */
  fromBuffer(buf: Uint8Array): T;
}
