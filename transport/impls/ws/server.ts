import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { ServerTransport, TransportOptions } from '../../transport';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'isomorphic-ws';
import { WebSocketConnection } from './connection';
import { Session } from '../../session';

export class WebSocketServerTransport extends ServerTransport<WebSocketConnection> {
  wss: WebSocketServer;

  constructor(
    wss: WebSocketServer,
    clientId: TransportClientId,
    providedOptions?: Partial<TransportOptions>,
  ) {
    super(clientId, providedOptions);
    this.wss = wss;
    this.wss.on('connection', this.connectionHandler);
  }

  connectionHandler = (ws: WebSocket) => {
    const conn = new WebSocketConnection(ws);
    log?.info(
      `${this.clientId} -- new incoming ws connection (id: ${conn.debugId})`,
    );
    let session: Session<WebSocketConnection> | undefined = undefined;
    const client = () => session?.connectedTo ?? 'unknown';
    conn.addDataListener(
      this.receiveWithBootSequence(conn, (establishedSession) => {
        session = establishedSession;
      }),
    );

    // close is always emitted, even on error, ok to do cleanup here
    ws.onclose = () => {
      if (!session) return;
      log?.info(
        `${this.clientId} -- websocket (id: ${
          conn.debugId
        }) to ${client()} disconnected`,
      );
      this.onDisconnect(conn, session?.connectedTo);
    };

    ws.onerror = (msg) => {
      if (!session) return;
      log?.warn(
        `${this.clientId} -- websocket (id: ${
          conn.debugId
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
