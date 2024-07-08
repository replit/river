import { ClientTransport } from '../../client';
import { TransportClientId } from '../../message';
import { ProvidedClientTransportOptions } from '../../options';
import { WebSocketConnection } from './connection';
import { WsLike } from './wslike';

/**
 * A transport implementation that uses a WebSocket connection with automatic reconnection.
 * @class
 * @extends Transport
 */
export class WebSocketClientTransport extends ClientTransport<WebSocketConnection> {
  /**
   * A function that returns a Promise that resolves to a websocket URL.
   */
  wsGetter: (to: TransportClientId) => Promise<WsLike> | WsLike;

  /**
   * Creates a new WebSocketClientTransport instance.
   * @param wsGetter A function that returns a Promise that resolves to a WebSocket instance.
   * @param clientId The ID of the client using the transport. This should be unique per session.
   * @param serverId The ID of the server this transport is connecting to.
   * @param providedOptions An optional object containing configuration options for the transport.
   */
  constructor(
    wsGetter: (to: TransportClientId) => Promise<WsLike> | WsLike,
    clientId: TransportClientId,
    providedOptions?: ProvidedClientTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.wsGetter = wsGetter;
  }

  async createNewOutgoingConnection(to: string) {
    this.log?.info(`establishing a new websocket to ${to}`, {
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

      ws.onerror = (err) => {
        reject(new Error(err.message));
      };
    });

    const conn = new WebSocketConnection(ws);
    this.log?.info(`raw websocket to ${to} ok, starting handshake`, {
      clientId: this.clientId,
      connectedTo: to,
    });

    return conn;
  }
}
