import {
  ClientTransport,
  ProvidedClientTransportOptions,
} from '../../transport';
import { TransportClientId } from '../../message';
import { log } from '../../../logging/log';
import { WebSocketConnection } from './connection';
import { WSLike } from './wslike';

/**
 * A transport implementation that uses a WebSocket connection with automatic reconnection.
 * @class
 * @extends Transport
 */
export class WebSocketClientTransport<
  CloseEvent extends { code: number; reason: string; wasClean: boolean } = {
    code: number;
    reason: string;
    wasClean: boolean;
  },
  MessageEvent extends { data: unknown } = { data: unknown },
  ErrorEvent extends object = object,
  OpenEvent extends object = object,
  BinaryType extends string = string,
> extends ClientTransport<
  WebSocketConnection<
    CloseEvent,
    MessageEvent,
    ErrorEvent,
    OpenEvent,
    BinaryType
  >
> {
  /**
   * A function that returns a Promise that resolves to a websocket URL.
   */
  wsGetter: (
    to: TransportClientId,
  ) =>
    | Promise<
        WSLike<CloseEvent, MessageEvent, ErrorEvent, OpenEvent, BinaryType>
      >
    | WSLike<CloseEvent, MessageEvent, ErrorEvent, OpenEvent, BinaryType>;

  /**
   * Creates a new WebSocketClientTransport instance.
   * @param wsGetter A function that returns a Promise that resolves to a WebSocket instance.
   * @param clientId The ID of the client using the transport. This should be unique per session.
   * @param serverId The ID of the server this transport is connecting to.
   * @param providedOptions An optional object containing configuration options for the transport.
   */
  constructor(
    wsGetter: (
      to: TransportClientId,
    ) =>
      | Promise<
          WSLike<CloseEvent, MessageEvent, ErrorEvent, OpenEvent, BinaryType>
        >
      | WSLike<CloseEvent, MessageEvent, ErrorEvent, OpenEvent, BinaryType>,
    clientId: TransportClientId,
    providedOptions?: ProvidedClientTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.wsGetter = wsGetter;
  }

  async createNewOutgoingConnection(to: string) {
    log?.info(`establishing a new websocket to ${to}`, {
      clientId: this.clientId,
      connectedTo: to,
    });

    const ws = await this.wsGetter(to);

    await new Promise<void>((resolve, reject) => {
      if (ws.readyState === ws.OPEN) {
        resolve();
        return;
      }

      if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) {
        reject(new Error('ws is closing or closed'));
        return;
      }

      ws.onopen = () => {
        resolve();
      };

      ws.onclose = (evt) => {
        reject(new Error(evt.reason));
      };
    });

    const conn = new WebSocketConnection(ws);
    log?.info(`raw websocket to ${to} ok, starting handshake`, {
      clientId: this.clientId,
      connectedTo: to,
    });

    this.handleConnection(conn, to);
    return conn;
  }
}
