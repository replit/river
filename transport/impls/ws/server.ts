import {
  type CustomHandshakeErrorCodeSchema,
  TransportClientId,
} from '../../message';
import { WebSocketServer } from 'ws';
import { WebSocketConnection } from './connection';
import { WsLike } from './wslike';
import { ServerTransport } from '../../server';
import { ProvidedServerTransportOptions } from '../../options';
import { type IncomingMessage } from 'http';
import type { TSchema } from 'typebox';
import type { ConnectionExtras } from '../../connection';

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

export type WebSocketConnectionExtrasFactory = (
  ws: WsLike,
  req: IncomingMessage,
) => ConnectionExtras;

const defaultConnectionExtrasFactory: WebSocketConnectionExtrasFactory = (
  _ws,
  req,
) => ({ headers: cleanHeaders(req.headersDistinct) });

export class WebSocketServerTransport<
  MetadataSchema extends TSchema = TSchema,
  ParsedMetadata extends object = object,
  RejectionCodeSchema extends CustomHandshakeErrorCodeSchema = never,
> extends ServerTransport<
  WebSocketConnection,
  MetadataSchema,
  ParsedMetadata,
  RejectionCodeSchema
> {
  wss: WebSocketServer;
  private readonly createConnectionExtras: WebSocketConnectionExtrasFactory;

  constructor(
    wss: WebSocketServer,
    clientId: TransportClientId,
    providedOptions?: ProvidedServerTransportOptions,
    createConnectionExtras: WebSocketConnectionExtrasFactory = defaultConnectionExtrasFactory,
  ) {
    super(clientId, providedOptions);
    this.wss = wss;
    this.createConnectionExtras = createConnectionExtras;
    this.wss.on('connection', this.connectionHandler);
  }

  connectionHandler = (ws: WsLike, req: IncomingMessage) => {
    const conn = new WebSocketConnection(
      ws,
      this.createConnectionExtras(ws, req),
    );

    this.handleConnection(conn);
  };

  close() {
    super.close();
    this.wss.off('connection', this.connectionHandler);
  }
}
