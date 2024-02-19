import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { Transport, TransportOptions } from '../../transport';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'isomorphic-ws';
import { WebSocketConnection } from './connection';
import { Session } from '../../session';

export class WebSocketServerTransport extends Transport<WebSocketConnection> {
  wss: WebSocketServer;

  constructor(
    wss: WebSocketServer,
    clientId: TransportClientId,
    providedOptions?: Partial<TransportOptions>,
  ) {
    super(clientId, providedOptions);
    this.wss = wss;
    wss.on('listening', () => {
      log?.info(`${this.clientId} -- server is listening`);
    });

    this.wss.on('connection', this.connectionHandler);
  }

  connectionHandler = (ws: WebSocket) => {
    const conn = new WebSocketConnection(ws);
    log?.info(
      `${this.clientId} -- new incoming ws connection (id: ${conn.id})`,
    );
    let session: Session<WebSocketConnection> | undefined = undefined;
    const client = () => session?.connectedTo ?? 'unknown';
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
      if (!session) return;
      log?.info(
        `${this.clientId} -- websocket (id: ${
          conn.id
        }) to ${client()} disconnected`,
      );
      this.onDisconnect(conn, session?.connectedTo);
    };

    ws.onerror = (msg) => {
      if (!session) return;
      log?.warn(
        `${this.clientId} -- websocket (id: ${
          conn.id
        }) to ${client()} got an error: ${msg}`,
      );
    };
  };

  async createNewOutgoingConnection(to: string): Promise<WebSocketConnection> {
    const err = `${this.clientId} -- failed to send msg to ${to}, client probably dropped`;
    log?.warn(err);
    throw new Error(err);
  }

  async close() {
    super.close();
    this.wss.off('connection', this.connectionHandler);
  }
}
