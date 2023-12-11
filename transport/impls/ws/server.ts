import { Codec, NaiveJsonCodec } from '../../../codec';
import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { Transport } from '../../transport';
import { Server } from 'ws';
import { WebSocketConnection } from './connection';

interface Options {
  codec: Codec;
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
};

export class WebSocketServerTransport extends Transport<WebSocketConnection> {
  wss: Server;
  clientId: TransportClientId;

  constructor(
    wss: Server,
    clientId: TransportClientId,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);
    this.wss = wss;
    this.clientId = clientId;
    this.setupConnectionStatusListeners();
  }

  setupConnectionStatusListeners(): void {
    this.wss.on('connection', (ws) => {
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
    });
  }

  async createNewConnection(to: string) {
    const err = `${this.clientId} -- failed to send msg to ${to}, client probably dropped`;
    log?.warn(err);
    return;
  }
}
