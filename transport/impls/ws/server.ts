import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { ServerTransport, TransportOptions } from '../../transport';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'isomorphic-ws';
import { WebSocketConnection } from './connection';

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
    this.handleConnection(conn);
  };

  close() {
    super.close();
    this.wss.off('connection', this.connectionHandler);
  }
}
