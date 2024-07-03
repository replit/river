import { type Socket } from 'node:net';
import stream from 'node:stream';
import {
  MessageFramer,
  Uint32LengthPrefixFraming,
} from '../../transforms/messageFraming';
import { Connection } from '../../connection';

export class UdsConnection extends Connection {
  sock: Socket;
  input: stream.Readable;
  framer: Uint32LengthPrefixFraming;
  constructor(sock: Socket) {
    super();
    this.framer = MessageFramer.createFramedStream();
    this.sock = sock;
    this.input = sock.pipe(this.framer);

    this.sock.on('close', () => {
      for (const cb of this.closeListeners) {
        cb();
      }
    });

    this.sock.on('error', (err) => {
      if (err instanceof Error && 'code' in err && err.code === 'EPIPE') {
        // Ignore EPIPE errors
        return;
      }

      for (const cb of this.errorListeners) {
        cb(err);
      }
    });

    this.input.on('data', (msg: Uint8Array) => {
      for (const cb of this.dataListeners) {
        cb(msg);
      }
    });
  }

  send(payload: Uint8Array) {
    if (this.framer.destroyed || !this.sock.writable) return false;
    return this.sock.write(MessageFramer.write(payload));
  }

  close() {
    this.sock.end();
    this.framer.destroy();
  }
}
