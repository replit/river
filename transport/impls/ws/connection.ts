import WebSocket from 'isomorphic-ws';
import { Connection } from '../../session';

export class WebSocketConnection extends Connection {
  ws: WebSocket;

  constructor(ws: WebSocket) {
    super();
    this.ws = ws;
    this.ws.binaryType = 'arraybuffer';
  }

  addDataListener(cb: (msg: Uint8Array) => void) {
    this.ws.onmessage = (msg) => cb(msg.data as Uint8Array);
  }

  removeDataListener(): void {
    this.ws.onmessage = null;
  }

  addCloseListener(cb: () => void): void {
    this.ws.onclose = cb;
  }

  addErrorListener(cb: (err: Error) => void): void {
    this.ws.onerror = (err) => cb(new Error(err.message));
  }

  send(payload: Uint8Array) {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(payload);
      return true;
    } else {
      return false;
    }
  }

  close() {
    this.ws.close();
  }
}
