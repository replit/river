import { Connection } from '../../connection';
import { WsLike } from './wslike';

interface ConnectionInfoExtras extends Record<string, unknown> {
  headers: Record<string, string>;
}

const WS_HEALTHY_CLOSE_CODE = 1000;

export class WebSocketConnection extends Connection {
  ws: WsLike;
  extras?: ConnectionInfoExtras;

  get loggingMetadata() {
    const metadata = super.loggingMetadata;
    if (this.extras) {
      metadata.extras = this.extras;
    }

    return metadata;
  }

  constructor(ws: WsLike, extras?: ConnectionInfoExtras) {
    super();
    this.ws = ws;
    this.extras = extras;
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

        this.onError(err);
      }

      this.onClose();
    };

    this.ws.onmessage = (msg) => {
      this.onData(msg.data as Uint8Array);
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
    // we close with 1000 normal even if its not really healthy at the river level
    // if we don't specify this, it defaults to 1005 which
    // some proxies/loggers detect as an error
    this.ws.close(WS_HEALTHY_CLOSE_CODE);
  }
}
