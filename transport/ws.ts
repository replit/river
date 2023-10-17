import WebSocket from 'isomorphic-ws';
import { Transport } from './types';
import { NaiveJsonCodec } from '../codec/json';
import {
  MessageId,
  OpaqueTransportMessage,
  TransportClientId,
} from './message';

interface Options {
  retryIntervalMs: number;
}

const defaultOptions: Options = {
  retryIntervalMs: 200,
};

type WebSocketResult = { ws: WebSocket } | { err: string };
export class WebSocketTransport extends Transport {
  wsGetter: () => Promise<WebSocket>;
  ws?: WebSocket;
  destroyed: boolean;
  reconnectPromise?: Promise<WebSocket>;
  options: Options;
  sendQueue: Array<MessageId>;

  constructor(
    wsGetter: () => Promise<WebSocket>,
    clientId: TransportClientId,
    options?: Partial<Options>,
  ) {
    super(NaiveJsonCodec, clientId);
    this.destroyed = false;
    this.wsGetter = wsGetter;
    this.options = { ...defaultOptions, ...options };
    this.sendQueue = [];
    this.tryConnect();
  }

  // postcondition: ws is concretely a WebSocket
  private async tryConnect() {
    const ws = await (this.reconnectPromise ?? this.wsGetter());

    // wait until it's ready or we get an error
    const res = await new Promise<WebSocketResult>((resolve) => {
      if (ws.readyState === ws.OPEN) {
        return resolve({ ws });
      }

      if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) {
        return resolve({ err: 'ws is closing or closed' });
      }

      ws.addEventListener('open', function onOpen() {
        ws.removeEventListener('open', onOpen);
        resolve({ ws });
      });

      ws.addEventListener('error', function onError(err) {
        ws.removeEventListener('error', onError);
        resolve({ err: err.message });
      });

      ws.addEventListener('close', function onClose(evt) {
        ws.removeEventListener('close', onClose);
        resolve({ err: evt.reason });
      });
    });

    if ('err' in res) {
      // TODO: logging
      setTimeout(() => this.tryConnect(), this.options.retryIntervalMs);
    } else {
      this.ws = res.ws;
      this.ws.onmessage = (msg) => this.onMessage(msg.data.toString());

      // send outstanding
      for (const id of this.sendQueue) {
        const msg = this.sendBuffer.get(id);
        if (msg) {
          this.ws.send(this.codec.toStringBuf(msg));
        }
      }
    }
  }

  send(msg: OpaqueTransportMessage): MessageId {
    const id = msg.id;
    if (this.destroyed) {
      return id;
    }

    this.sendBuffer.set(id, msg);
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(this.codec.toStringBuf(msg));
    } else {
      this.sendQueue.push(id);
      this.tryConnect().catch();
    }

    return id;
  }

  async close() {
    this.destroyed = true;
    return this.ws?.close();
  }
}
