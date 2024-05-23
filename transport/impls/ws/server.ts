import { TransportClientId } from '../../message';
import {
  ServerTransport,
  ProvidedServerTransportOptions,
} from '../../transport';
import { WebSocketServer } from 'ws';
import { WebSocketConnection } from './connection';
import { WsLike } from './wslike';

export class WebSocketServerTransport extends ServerTransport<WebSocketConnection> {
  wss: WebSocketServer;

  constructor(
    wss: WebSocketServer,
    clientId: TransportClientId,
    providedOptions?: ProvidedServerTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.wss = wss;
    this.wss.on('connection', this.connectionHandler);
  }

  connectionHandler = (ws: WsLike) => {
    const conn = new WebSocketConnection(ws);
    this.handleConnection(conn);
  };

  close() {
    super.close();
    this.wss.off('connection', this.connectionHandler);
  }
}
