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
  rawHeaders: IncomingMessage['rawHeaders'],
): Record<string, string> {
  const cleanedHeaders: Record<string, string> = {};

  // Avoid req.headersDistinct: Node builds it lazily and can throw when a
  // request contains a header named "__proto__".
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i].toLowerCase();

    // Match headersDistinct's first-value behavior for duplicate headers.
    if (
      key.startsWith('sec-') ||
      Object.prototype.hasOwnProperty.call(cleanedHeaders, key)
    ) {
      continue;
    }

    // Define an own data property so "__proto__" cannot invoke the legacy
    // prototype setter or disappear from the returned headers.
    Object.defineProperty(cleanedHeaders, key, {
      configurable: true,
      enumerable: true,
      value: rawHeaders[i + 1],
      writable: true,
    });
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
) => ({ headers: cleanHeaders(req.rawHeaders) });

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
