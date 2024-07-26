import { TransportClientId } from '../../message';
import { WebSocketServer } from 'ws';
import { WebSocketConnection } from './connection';
import { WsLike } from './wslike';
import { ServerTransport } from '../../server';
import { ProvidedServerTransportOptions } from '../../options';
import { type IncomingMessage } from 'http';

function cleanHeaders(
  headers: IncomingMessage['headers'],
): Record<string, string> {
  const cleanedHeaders: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (!key.startsWith('sec-') && value) {
      const cleanedValue = Array.isArray(value) ? value[0] : value;
      cleanedHeaders[key] = cleanedValue;
    }
  }

  return cleanedHeaders;
}

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

  connectionHandler = (ws: WsLike, req: IncomingMessage) => {
    const conn = new WebSocketConnection(ws, {
      headers: cleanHeaders(req.headersDistinct),
    });

    this.handleConnection(conn);
  };

  close() {
    super.close();
    this.wss.off('connection', this.connectionHandler);
  }
}
