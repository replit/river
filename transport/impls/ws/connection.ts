import { Connection } from '../../connection';
import { WsLike } from './wslike';

export class WebSocketConnection extends Connection {
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
      if (didError) {
        const err = new Error(
          `websocket closed with code and reason: ${code} - ${reason}`,
        );

        for (const cb of this.errorListeners) {
          cb(err);
        }
      }

      for (const cb of this.closeListeners) {
        cb();
      }
    };

    this.ws.onmessage = (msg) => {
      for (const cb of this.dataListeners) {
        cb(msg.data as Uint8Array);
      }
    };
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
