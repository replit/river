import { Connection } from '../..';
import {
  MessageFramer,
  Uint32LengthPrefixFraming,
} from '../../transforms/messageFraming';

export class StreamConnection extends Connection {
  output: NodeJS.WritableStream;

  constructor(output: NodeJS.WritableStream) {
    super();
    this.output = output;
  }

  onData(cb: (msg: Uint8Array) => void) {
    // this.input.on('data', cb);
  }

  send(payload: Uint8Array) {
    if (!this.output.writable) {
      return false;
    }

    return this.output.write(MessageFramer.write(payload));
  }

  async close() {
    // this.framer.destroy();
    this.output.end();
  }
}
