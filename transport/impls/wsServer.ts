import { Codec, NaiveJsonCodec } from '../../codec';
import { log } from '../../logging';
import {
  MessageId,
  OpaqueTransportMessage,
  TransportClientId,
} from '../message';
import { Transport } from '../types';
import { Server, WebSocket } from 'ws';

interface Options {
  codec: Codec;
  binaryType: 'arraybuffer';
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
  binaryType: 'arraybuffer',
};

export class WebSocketServerTransport extends Transport {
  wss: Server;
  connMap: Map<TransportClientId, WebSocket>;

  constructor(
    wss: Server,
    clientId: TransportClientId,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);
    this.wss = wss;
    this.connMap = new Map();

    wss.on('connection', (ws) => {
      ws.binaryType = options.binaryType;

      let from: TransportClientId = 'unknown';
      ws.on('error', (msg) => {
        log?.warn(`${clientId} -- ws error from client ${from}: ${msg}`);
      });

      ws.on('close', () => {
        log?.info(`${clientId} -- got connection close from ${from}`);
        if (from !== 'unknown') {
          this.connMap.delete(from);
        }
      });

      ws.onmessage = (msg) =>
        this.onMessage(msg.data as Uint8Array, (parsed) => {
          from = parsed.from;
          log?.info(`${clientId} -- new connection from ${from}`);
          if (from !== 'unknown') {
            this.connMap.set(from, ws);
          }
        });
    });
  }

  send(msg: OpaqueTransportMessage): MessageId {
    if (msg.to === 'broadcast') {
      for (const conn of this.connMap.values()) {
        log?.info(`${this.clientId} -- sending ${JSON.stringify(msg)}`);
        conn.send(this.codec.toBuffer(msg));
      }
      return msg.id;
    }

    const conn = this.connMap.get(msg.to);
    if (conn) {
      log?.info(`${this.clientId} -- sending ${JSON.stringify(msg)}`);
      conn.send(this.codec.toBuffer(msg));
      return msg.id;
    } else {
      const err = `${this.clientId} -- failed to send msg to ${msg.to}, no connection`;
      log?.warn(err);
      throw new Error(err);
    }
  }

  async close() {
    for (const conn of this.connMap.values()) {
      conn.close();
    }

    this.wss.close();
    log?.info('closed ws server');
  }
}
