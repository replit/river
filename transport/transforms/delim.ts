import { Transform, TransformCallback, TransformOptions } from 'node:stream';

export interface DelimiterOptions extends TransformOptions {
  /** The delimiter on which to split incoming data. */
  delimiter: Buffer;
  /** Maximum in-memory buffer size before we throw */
  maxBufferSizeBytes: number;
}

/**
 * A transform stream that emits data each time a byte sequence is received.
 * @extends Transform
 */
export class DelimiterParser extends Transform {
  delimiter: Buffer;
  buffer: Buffer;
  maxBufferSizeBytes: number;

  constructor({ delimiter, maxBufferSizeBytes, ...options }: DelimiterOptions) {
    super(options);
    this.maxBufferSizeBytes = maxBufferSizeBytes;
    this.delimiter = Buffer.from(delimiter);
    this.buffer = Buffer.alloc(0);
  }

  // tldr; backpressure will be automatically applied for transform streams
  // but it relies on both the input/output streams connected on either end having
  // implemented backpressure properly
  // see: https://nodejs.org/en/guides/backpressuring-in-streams#lifecycle-of-pipe
  _transform(chunk: Buffer, _encoding: BufferEncoding, cb: TransformCallback) {
    let data = Buffer.concat([this.buffer, chunk]);
    let position;
    while ((position = data.indexOf(this.delimiter)) !== -1) {
      this.push(data.subarray(0, position));
      data = data.subarray(position + this.delimiter.length);
    }

    if (data.byteLength > this.maxBufferSizeBytes) {
      const err = new Error(
        `buffer overflow: ${data.byteLength}B > ${this.maxBufferSizeBytes}B`,
      );
      this.emit('error', err);
      return cb(err);
    }

    this.buffer = data;
    cb();
  }

  _flush(cb: TransformCallback) {
    if (this.buffer.length) {
      this.push(this.buffer);
    }

    this.buffer = Buffer.alloc(0);
    cb();
  }

  // node v14 sets `autoDestroy` to true which automatically calls
  // destroy() on the stream when it emits 'finish' or errors.
  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.buffer = Buffer.alloc(0);
    super._destroy(error, callback);
  }
}

export const defaultDelimiter = Buffer.from('\n');
export function createDelimitedStream(options?: Partial<DelimiterOptions>) {
  return new DelimiterParser({
    delimiter: options?.delimiter ?? defaultDelimiter,
    maxBufferSizeBytes: options?.maxBufferSizeBytes ?? 16 * 1024 * 1024, // 16MB
  });
}
