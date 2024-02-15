import { Codec, NaiveJsonCodec } from '../../../codec';
import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { Transport } from '../../transport';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'isomorphic-ws';
import { WebSocketConnection } from './connection';
import { Session } from '../../session';

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
    log?.info(`${this.clientId} -- new incoming ws connection`);
    const conn = new WebSocketConnection(ws);
    let session: Session<WebSocketConnection> | undefined = undefined;
    conn.onData((data) => {
      const parsed = this.parseMsg(data);
      if (!parsed) return;
      if (!session) {
        session = this.onConnect(conn, parsed.from);
      }

      this.handleMsg(parsed);
    });

    // close is always emitted, even on error, ok to do cleanup here
    ws.onclose = () => {
      log?.info(
        `${this.clientId} -- websocket to ${
          session?.connectedTo ?? 'unknown'
        } disconnected`,
      );
      this.onDisconnect(conn, session?.connectedTo);
    };

    ws.onerror = (msg) => {
      log?.warn(
        `${this.clientId} -- websocket to ${
          session?.connectedTo ?? 'unknown'
        } got an error: ${msg}`,
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
