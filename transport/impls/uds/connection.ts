import { Connection } from '../../session';
import { type Socket } from 'node:net';
import stream from 'node:stream';
import {
  MessageFramer,
  Uint32LengthPrefixFraming,
} from '../../transforms/messageFraming';

export class UdsConnection extends Connection {
  sock: Socket;
  input: stream.Readable;
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

  removeDataListener(cb: (msg: Uint8Array) => void): void {
    this.input.off('data', cb);
  }

  addCloseListener(cb: () => void): void {
    this.sock.on('close', cb);
  }

  removeCloseListener(cb: () => void): void {
    this.sock.off('close', cb);
  }

  addErrorListener(cb: (err: Error) => void): void {
    this.sock.on('error', (err) => {
      if (err instanceof Error && 'code' in err && err.code === 'EPIPE') {
        // Ignore EPIPE errors
        return;
      }

      cb(err);
    });
  }

  removeErrorListener(cb: (err: Error) => void): void {
    this.sock.off('error', cb);
  }

  send(payload: Uint8Array) {
    if (this.framer.destroyed || !this.sock.writable) return false;
    return this.sock.write(MessageFramer.write(payload));
  }

  close() {
    this.sock.destroy();
    this.framer.destroy();
  }
}
