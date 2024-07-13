import { Transform, TransformCallback, TransformOptions } from 'node:stream';

export interface LengthEncodedOptions extends TransformOptions {
  /** Maximum in-memory buffer size before we throw */
  maxBufferSizeBytes: number;
}

/**
 * A transform stream that emits data each time a message with a network/BigEndian uint32 length prefix is received.
 * @extends Transform
 */
export class Uint32LengthPrefixFraming extends Transform {
  receivedBuffer: Buffer;
  maxBufferSizeBytes: number;

  constructor({ maxBufferSizeBytes, ...options }: LengthEncodedOptions) {
    super(options);
    this.maxBufferSizeBytes = maxBufferSizeBytes;
    this.receivedBuffer = Buffer.alloc(0);
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, cb: TransformCallback) {
    if (
      this.receivedBuffer.byteLength + chunk.byteLength >
      this.maxBufferSizeBytes
    ) {
      const err = new Error(
        `buffer overflow: ${this.receivedBuffer.byteLength}B > ${this.maxBufferSizeBytes}B`,
      );

      this.emit('error', err);
      cb(err);
      return;
    }

    this.receivedBuffer = Buffer.concat([this.receivedBuffer, chunk]);

    // ensure there's enough for a length prefix
    while (this.receivedBuffer.length > 4) {
      // read length from buffer (accounting for uint32 prefix)
      const claimedMessageLength = this.receivedBuffer.readUInt32BE(0) + 4;
      if (this.receivedBuffer.length >= claimedMessageLength) {
        // slice the buffer to extract the message
        const message = this.receivedBuffer.subarray(4, claimedMessageLength);
        this.push(message);
        this.receivedBuffer =
          this.receivedBuffer.subarray(claimedMessageLength);
      } else {
        // not enough data for a complete message, wait for more data
        break;
      }
    }

    cb();
  }

  _flush(cb: TransformCallback) {
    this.receivedBuffer = Buffer.alloc(0);
    cb();
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.receivedBuffer = Buffer.alloc(0);
    super._destroy(error, callback);
  }
}

function createLengthEncodedStream(options?: Partial<LengthEncodedOptions>) {
  return new Uint32LengthPrefixFraming({
    maxBufferSizeBytes: options?.maxBufferSizeBytes ?? 16 * 1024 * 1024, // 16MB
  });
}

export const MessageFramer = {
  createFramedStream: createLengthEncodedStream,
  write: (buf: Uint8Array) => {
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32BE(buf.length, 0);
    return Buffer.concat([lengthPrefix, buf]);
  },
};
