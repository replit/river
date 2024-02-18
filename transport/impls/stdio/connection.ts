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
    this.framer = MessageFramer.createFramedStream();
    this.input = input.pipe(this.framer);
    this.output = output;
  }

  onData(cb: (msg: Uint8Array) => void) {
    this.input.on('data', cb);
  }

  send(payload: Uint8Array) {
    if (!this.output.writable) {
      return false;
    }
    return this.output.write(MessageFramer.write(payload));
  }

  async close() {
    this.output.end();
    this.framer.destroy();
  }
}
