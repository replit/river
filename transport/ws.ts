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
  retryIntervalMs: 250,
};

type WebSocketResult = { ws: WebSocket } | { err: string };
export class WebSocketTransport extends Transport {
  wsGetter: () => Promise<WebSocket>;
  ws?: WebSocket;
  destroyed: boolean;
  reconnectPromise?: Promise<WebSocketResult>;
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
    // wait until it's ready or we get an error
    this.reconnectPromise ??= new Promise<WebSocketResult>(async (resolve) => {
      const ws = await this.wsGetter();
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
    const res = await this.reconnectPromise;

    // only send if we resolved a valid websocket
    if ('ws' in res && res.ws.readyState === res.ws.OPEN) {
      this.ws = res.ws;
      this.ws.onmessage = (msg) => this.onMessage(msg.data.toString());
      this.ws.onclose = () => {
        this.reconnectPromise = undefined;
        this.tryConnect().catch();
      };

      // send outstanding
      for (const id of this.sendQueue) {
        const msg = this.sendBuffer.get(id);
        if (!msg) {
          throw new Error('tried to resend a message we received an ack for');
        }

        this.ws.send(this.codec.toStringBuf(msg));
      }

      this.sendQueue = [];
      return;
    }

    // otherwise try and reconnect again
    this.reconnectPromise = undefined;
    setTimeout(() => this.tryConnect(), this.options.retryIntervalMs);
  }

  send(msg: OpaqueTransportMessage): MessageId {
    const id = msg.id;
    if (this.destroyed) {
      throw new Error('ws is destroyed, cant send');
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
