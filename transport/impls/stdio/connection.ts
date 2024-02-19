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
    return this.output.write(MessageFramer.write(payload));
  }

  // doesn't touch the underlying connection
  async close() {
    this.output.end();
    this.input.unpipe(this.framer);
    this.framer.destroy();
  }
}
