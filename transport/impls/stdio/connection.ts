import { Connection } from '../..';
import {
  MessageFramer,
  Uint32LengthPrefixFraming,
} from '../../transforms/messageFraming';

export class StreamConnection extends Connection {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  framer: Uint32LengthPrefixFraming;

  constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
    super();
    this.input = input;
    this.output = output;
    this.framer = MessageFramer.createFramedStream();
  }

  onData(cb: (msg: Uint8Array) => void) {
    this.input.pipe(this.framer).on('data', cb);
  }

  send(payload: Uint8Array) {
    if (!this.output.writable) {
      return false;
    }
    return this.output.write(MessageFramer.write(payload));
  }

  async close() {
    this.framer.destroy();
    this.output.end();
  }
}
