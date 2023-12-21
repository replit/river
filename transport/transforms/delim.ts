import { Transform, TransformCallback, TransformOptions } from 'stream';

export interface DelimiterOptions extends TransformOptions {
  /** The delimiter on which to split incoming data. */
  delimiter: string | Buffer;
}

/**
 * A transform stream that emits data each time a byte sequence is received.
 * @extends Transform
 */
export class DelimiterParser extends Transform {
  delimiter: Buffer;
  buffer: Buffer;

  constructor({ delimiter, ...options }: DelimiterOptions) {
    super(options);
    this.delimiter = Buffer.from(delimiter);
    this.buffer = Buffer.alloc(0);
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, cb: TransformCallback) {
    let data = Buffer.concat([this.buffer, chunk]);

    let position;
    while ((position = data.indexOf(this.delimiter)) !== -1) {
      this.push(data.subarray(0, position));
      data = data.subarray(position + this.delimiter.length);
    }

    this.buffer = data;
    cb();
  }

  _flush(cb: TransformCallback) {
    this.push(this.buffer);
    this.buffer = Buffer.alloc(0);
    cb();
  }
}

export const defaultDelimiter = Buffer.from('\n');
export function createDelimitedStream(delimiter?: Buffer): DelimiterParser {
  return new DelimiterParser({ delimiter: delimiter ?? defaultDelimiter });
}
