import { Codec, NaiveJsonCodec } from '../../../codec';
import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { Transport } from '../../transport';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'isomorphic-ws';
import { WebSocketConnection } from './connection';

interface Options {
  codec: Codec;
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
};

export class WebSocketServerTransport extends Transport<WebSocketConnection> {
  wss: WebSocketServer;

  constructor(
    wss: WebSocketServer,
    clientId: TransportClientId,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);
    this.wss = wss;
    wss.on('listening', () => {
      log?.info(`${this.clientId} -- server is listening`);
    });

    this.wss.on('connection', this.connectionHandler);
  }

  connectionHandler = (ws: WebSocket) => {
    let conn: WebSocketConnection | undefined = undefined;

    ws.onmessage = (msg) => {
      // when we establish WebSocketConnection, ws.onmessage
      // gets overriden so this only runs on the first valid message
      // the websocket receives
      const parsedMsg = this.parseMsg(msg.data as Uint8Array);
      if (parsedMsg && !conn) {
        conn = new WebSocketConnection(this, parsedMsg.from, ws);
        this.onConnect(conn);
        this.handleMsg(parsedMsg);
      }
    };

    // close is always emitted, even on error, ok to do cleanup here
    ws.onclose = () => {
      if (conn) {
        this.onDisconnect(conn);
      }
    };

    ws.onerror = (msg) => {
      log?.warn(
        `${this.clientId} -- ws error from client ${
          conn?.connectedTo ?? 'unknown'
        }: ${msg}`,
      );
    };
  };

  async createNewConnection(to: string) {
    const err = `${this.clientId} -- failed to send msg to ${to}, client probably dropped`;
    log?.warn(err);
    return;
  }

  async close() {
    super.close();
    this.wss.off('connection', this.connectionHandler);
  }
}
