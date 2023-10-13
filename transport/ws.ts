import WebSocket from 'isomorphic-ws';
import { Transport } from './types';
import { NaiveJsonCodec } from '../codec/json';
import {
  MessageId,
  OpaqueTransportMessage,
  TransportClientId,
} from './message';

// TODO should answer:
// - how do we handle graceful client disconnects? (i.e. close tab)
// - how do we handle graceful service disconnects (i.e. a fuck off message)?
// - how do we handle forceful client disconnects? (i.e. broken connection, offline)
// - how do we handle forceful service disconnects (i.e. a crash)?
export class WebSocketTransport extends Transport {
  wsGetter: () => Promise<WebSocket>;
  ws?: WebSocket;
  destroyed: boolean;

  constructor(wsGetter: () => Promise<WebSocket>, clientId: TransportClientId) {
    super(NaiveJsonCodec, clientId);
    this.destroyed = false;
    this.wsGetter = wsGetter;
    this.waitForSocketReady();
  }

  // postcondition: ws is concretely a WebSocket
  private async waitForSocketReady(): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('ws is destroyed'));
        return;
      }

      if (this.ws) {
        // constructed ws but not open
        if (this.ws.readyState === this.ws.OPEN) {
          return resolve(this.ws);
        }

        // resolve on open
        this.ws.onopen = (evt) => {
          return resolve(evt.target);
        };

        // reject if borked
        this.ws.onerror = (err) => reject(err);
      } else {
        // not constructed
        this.wsGetter().then((ws) => {
          this.ws = ws;
          return resolve(this.waitForSocketReady());
        });
      }
    }).then((ws) => {
      ws.onmessage = (msg) => this.onMessage(msg.data.toString());
      return ws;
    });
  }

  async send(msg: OpaqueTransportMessage): Promise<MessageId> {
    const id = msg.id;
    const ws = await this.waitForSocketReady();
    ws.send(this.codec.toStringBuf(msg));
    return id;
  }

  async close() {
    this.destroyed = true;
    return this.ws?.close();
  }
}
