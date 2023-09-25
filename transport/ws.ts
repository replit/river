import type WebSocket from 'isomorphic-ws';
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
  ws: WebSocket;

  constructor(ws: WebSocket, clientId: TransportClientId) {
    super(NaiveJsonCodec, clientId);
    this.ws = ws;
    ws.on('message', (msg) => this.onMessage(msg.toString()));
  }

  send(msg: OpaqueTransportMessage): MessageId {
    const id = msg.id;
    this.ws.send(this.codec.toStringBuf(msg));
    return id;
  }

  async close() {
    return this.ws.close();
  }
}
