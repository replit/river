import { Connection } from '../../session';
import { type Socket } from 'node:net';
import {
  MessageFramer,
  Uint32LengthPrefixFraming,
} from '../../transforms/messageFraming';

export class UdsConnection extends Connection {
  sock: Socket;
  framer: Uint32LengthPrefixFraming;

  constructor(sock: Socket) {
    super();
    this.sock = sock;
    this.framer = MessageFramer.createFramedStream();
  }

  onData(cb: (msg: Uint8Array) => void) {
    this.sock.pipe(this.framer).on('data', cb);
  }

  send(payload: Uint8Array) {
    if (this.sock.writable) {
      return this.sock.write(MessageFramer.write(payload));
    } else {
      return false;
    }
  }

  async close() {
    this.framer.destroy();
    this.sock.destroy();
  }
}
