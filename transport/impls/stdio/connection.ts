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

  addDataListener(cb: (msg: Uint8Array) => void) {
    this.input.on('data', cb);
  }

  removeDataListener(cb: (msg: Uint8Array) => void): void {
    this.input.off('data', cb);
  }

  addCloseListener(cb: () => void): void {
    this.input.on('close', cb);
    this.output.on('close', cb);
  }

  addErrorListener(cb: (err: Error) => void): void {
    this.input.on('error', cb);
    this.output.on('error', cb);
  }

  send(payload: Uint8Array) {
    return this.output.write(MessageFramer.write(payload));
  }

  async close() {
    this.output.end();
    this.input.unpipe(this.framer);
    this.framer.destroy();
  }
}
