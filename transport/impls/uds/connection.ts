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

  addDataListener(cb: (msg: Uint8Array) => void) {
    this.input.on('data', cb);
  }

  send(payload: Uint8Array) {
    return this.sock.write(MessageFramer.write(payload));
  }

  async close() {
    this.sock.destroy();
    this.framer.destroy();
  }
}
