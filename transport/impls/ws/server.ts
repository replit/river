import { TransportClientId } from '../../message';
import { ServerTransport, ProvidedTransportOptions } from '../../transport';
import { WebSocketServer } from 'ws';
import { WebSocket } from 'isomorphic-ws';
import { WebSocketConnection } from './connection';

export class WebSocketServerTransport extends ServerTransport<WebSocketConnection> {
  wss: WebSocketServer;

  constructor(
    wss: WebSocketServer,
    clientId: TransportClientId,
    providedOptions?: Partial<ProvidedTransportOptions>,
  ) {
    super(clientId, providedOptions);
    this.wss = wss;
    this.wss.on('connection', this.connectionHandler);
  }

  connectionHandler = (ws: WebSocket) => {
    const conn = new WebSocketConnection(ws);
    this.handleConnection(conn);
  };

  close() {
    super.close();
    this.wss.off('connection', this.connectionHandler);
  }
}
