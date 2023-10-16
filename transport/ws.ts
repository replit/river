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

// TODO should answer:
// - how do we handle graceful client disconnects? (i.e. close tab)
// - how do we handle graceful service disconnects (i.e. a fuck off message)?
// - how do we handle forceful client disconnects? (i.e. broken connection, offline)
// - how do we handle forceful service disconnects (i.e. a crash)?
export class WebSocketTransport extends Transport {
  wsGetter: () => Promise<WebSocket>;
  ws?: WebSocket;
  destroyed: boolean;
  reconnecting: boolean;
  lastRetryEpoch: number;
  options: Options;
  sendQueue: Array<MessageId>;

  constructor(
    wsGetter: () => Promise<WebSocket>,
    clientId: TransportClientId,
    options?: Partial<Options>,
  ) {
    super(NaiveJsonCodec, clientId);
    this.destroyed = false;
    this.reconnecting = false;
    this.wsGetter = wsGetter;
    this.lastRetryEpoch = 0;
    this.options = { ...defaultOptions, ...options };
    this.sendQueue = [];
    this.tickSendLoop();
  }

  // postcondition: ws is concretely a WebSocket
  private async waitForSocketReady() {
    const ws = this.ws ?? (await this.wsGetter());

    try {
      const resolvedWs = await new Promise<WebSocket>((resolve, reject) => {
        if (ws.readyState === ws.OPEN) {
          return resolve(ws);
        }

        if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) {
          return reject('ws is closing or closed');
        }

        ws.addEventListener('open', function onOpen() {
          ws.removeEventListener('open', onOpen);
          resolve(ws);
        });

        ws.addEventListener('error', function onError(err) {
          ws.removeEventListener('error', onError);
          reject(err);
        });

        ws.addEventListener('close', function onClose(evt) {
          ws.removeEventListener('close', onClose);
          reject(evt.reason);
        });
      });

      this.ws = resolvedWs;
      this.ws.onmessage = (msg) => this.onMessage(msg.data.toString());
    } catch (e) {
      this.ws = undefined;
    }

    this.reconnecting = false;
  }

  send(msg: OpaqueTransportMessage): MessageId {
    const id = msg.id;
    this.sendQueue.push(id);
    this.sendBuffer.set(id, msg);
    return id;
  }

  // Didn't want to make `send()` async but we also wanted to keep message send order in the face of
  // async (and possibly failing) sends. Easiest way to solve this ended up being a send queue that
  // gets polled on. This is what the Node event loop does anyways so hooking into that isn't terrible lol (?)
  private tickSendLoop() {
    if (this.destroyed) {
      return;
    }

    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      // TODO; probably just send the whole queue lol
      // take something off of the queue and send it
      const id = this.sendQueue.shift();
      if (id !== undefined) {
        const msg = this.sendBuffer.get(id);
        if (msg) {
          this.ws.send(this.codec.toStringBuf(msg));
        }
      }
    } else if (
      !this.reconnecting &&
      Date.now() - this.lastRetryEpoch > this.options.retryIntervalMs
    ) {
      this.lastRetryEpoch = Date.now();
      this.reconnecting = true;
      this.waitForSocketReady().catch();
    }

    setImmediate(() => this.tickSendLoop());
  }

  async close() {
    this.destroyed = true;
    return this.ws?.close();
  }
}
