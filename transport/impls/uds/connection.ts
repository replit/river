import { Connection } from '../../session';
import { type Socket } from 'node:net';
import {
  MessageFramer,
  Uint32LengthPrefixFraming,
} from '../../transforms/messageFraming';

export class UdsConnection extends Connection {
  sock: Socket;
  input: NodeJS.ReadableStream;
  framer: Uint32LengthPrefixFraming;

  constructor(sock: Socket) {
    super();
    this.framer = MessageFramer.createFramedStream();
    this.sock = sock;
    this.input = sock.pipe(this.framer);
  }

  onData(cb: (msg: Uint8Array) => void) {
    this.input.on('data', cb);
  }

  send(payload: Uint8Array) {
    if (this.sock.writable) {
      return this.sock.write(MessageFramer.write(payload));
    } else {
      return false;
    }
  }

  async close() {
    this.sock.destroy();
    this.framer.destroy();
  }
}
