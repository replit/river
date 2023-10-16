import WebSocket from 'isomorphic-ws';
import { Transport } from './types';
import { NaiveJsonCodec } from '../codec/json';
import {
  MessageId,
  OpaqueTransportMessage,
  TransportClientId,
} from './message';

interface Options {
  retryCountLimit: number;
  retryIntervalMs: number;
}

const defaultOptions: Options = {
  retryCountLimit: 5,
  retryIntervalMs: 200,
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// TODO should answer:
// - how do we handle graceful client disconnects? (i.e. close tab)
// - how do we handle graceful service disconnects (i.e. a fuck off message)?
// - how do we handle forceful client disconnects? (i.e. broken connection, offline)
// - how do we handle forceful service disconnects (i.e. a crash)?
export class WebSocketTransport extends Transport {
  wsGetter: () => Promise<WebSocket>;
  ws?: WebSocket;
  destroyed: boolean;
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
    this.tickSendLoop();
  }

  // postcondition: ws is concretely a WebSocket
  private async waitForSocketReady(retryCount = 0): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      if (this.destroyed) {
        return reject(new Error('ws is destroyed'));
      }

      const retry = () =>
        this.wsGetter().then((ws) => {
          this.ws = ws;
          return this.waitForSocketReady(retryCount + 1);
        });

      if (this.ws) {
        // resolve on open
        if (this.ws.readyState === this.ws.OPEN) {
          return resolve(this.ws);
        }

        this.ws.onopen = (evt) => {
          return resolve(evt.target);
        };

        this.ws.onerror = (err) => {
          // reject if retry limit reached
          if (retryCount === this.options.retryCountLimit) {
            err.message = `ws still failing after ${this.options.retryCountLimit} tries: ${err.message}`;
            return reject(err);
          }

          // otherwise, retry
          return delay(this.options.retryIntervalMs).then(() => retry());
        };

        this.ws.onclose = (evt) => {
          // TODO: logging here
        };
      } else {
        // ws not constructed, init and try again
        return retry();
      }
    }).then((ws) => {
      ws.onmessage = (msg) => this.onMessage(msg.data.toString());
      return ws;
    });
  }

  send(msg: OpaqueTransportMessage): MessageId {
    const id = msg.id;
    this.sendQueue.push(id);
    this.sendBuffer.set(id, msg);
    return id;
  }

  private tickSendLoop() {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      const id = this.sendQueue.shift();
      if (id !== undefined) {
        const msg = this.sendBuffer.get(id);
        if (msg) {
          this.ws.send(this.codec.toStringBuf(msg));
        }
      }
    } else {
      this.waitForSocketReady().catch();
    }

    if (!this.destroyed) {
      setImmediate(() => this.tickSendLoop());
    }
  }

  async close() {
    this.destroyed = true;
    return this.ws?.close();
  }
}
