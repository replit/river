import { Connection } from '../../session';
import { WsLike } from './wslike';

export class WebSocketConnection extends Connection {
  errorCb: null | ((err: Error) => void) = null;
  closeCb: null | (() => void) = null;

  ws: WsLike;

  constructor(ws: WsLike) {
    super();
    this.ws = ws;
    this.ws.binaryType = 'arraybuffer';

    // Websockets are kinda shitty, they emit error events with no
    // information other than it errored, so we have to do some extra
    // work to figure out what happened.
    let didError = false;
    this.ws.onerror = () => {
      didError = true;
    };
    this.ws.onclose = ({ code, reason }) => {
      if (didError && this.errorCb) {
        this.errorCb(
          new Error(
            `websocket closed with code and reason: ${code} - ${reason}`,
          ),
        );
      }

      if (this.closeCb) {
        this.closeCb();
      }
    };
  }

  addDataListener(cb: (msg: Uint8Array) => void) {
    this.ws.onmessage = (msg) => cb(msg.data as Uint8Array);
  }

  removeDataListener(): void {
    this.ws.onmessage = null;
  }

  addCloseListener(cb: () => void): void {
    this.closeCb = cb;
  }

  addErrorListener(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  send(payload: Uint8Array) {
    if (this.ws.readyState !== this.ws.OPEN) {
      return false;
    }
    this.ws.send(payload);
    return true;
  }

  close() {
    this.ws.close();
  }
}
