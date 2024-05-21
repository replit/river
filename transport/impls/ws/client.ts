import WebSocket, { CloseEvent, ErrorEvent } from 'agnostic-ws';
import {
  ClientTransport,
  ProvidedClientTransportOptions,
} from '../../transport';
import { TransportClientId } from '../../message';
import { log } from '../../../logging/log';
import { WebSocketConnection } from './connection';

type WebSocketResult = { ws: WebSocket } | { err: string };
type UrlGetter = (to: TransportClientId) => Promise<string> | string;

/**
 * A transport implementation that uses a WebSocket connection with automatic reconnection.
 * @class
 * @extends Transport
 */
export class WebSocketClientTransport extends ClientTransport<WebSocketConnection> {
  /**
   * A function that returns a Promise that resolves to a websocket URL.
   */
  urlGetter: (to: TransportClientId) => Promise<string> | string;

  /**
   * Creates a new WebSocketClientTransport instance.
   * @param wsGetter A function that returns a Promise that resolves to a WebSocket instance.
   * @param clientId The ID of the client using the transport. This should be unique per session.
   * @param serverId The ID of the server this transport is connecting to.
   * @param providedOptions An optional object containing configuration options for the transport.
   */
  constructor(
    urlGetter: UrlGetter,
    clientId: TransportClientId,
    providedOptions?: ProvidedClientTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.urlGetter = urlGetter;
  }

  async createNewOutgoingConnection(to: string) {
    // get a promise to an actual websocket that's ready
    const wsRes = await new Promise<WebSocketResult>((resolve) => {
      log?.info(`establishing a new websocket to ${to}`, {
        clientId: this.clientId,
        connectedTo: to,
      });

      const urlMaybePromise = this.urlGetter(to);
      const urlPromise =
        urlMaybePromise instanceof Promise
          ? urlMaybePromise
          : Promise.resolve(urlMaybePromise);

      urlPromise
        .then((url) => new WebSocket(url))
        .then((ws) => {
          if (ws.readyState === WebSocket.OPEN) {
            resolve({ ws });
            return;
          }

          if (
            ws.readyState === WebSocket.CLOSING ||
            ws.readyState === WebSocket.CLOSED
          ) {
            resolve({ err: 'ws is closing or closed' });
            return;
          }

          ws.onopen = () => {
            resolve({ ws });
          };

          ws.onclose = (evt: CloseEvent) => {
            resolve({ err: evt.reason });
          };

          ws.onerror = (evt: ErrorEvent) => {
            const err = evt.error;
            resolve({
              err: `${err.name}: ${err.message}`,
            });
          };
        })
        .catch((e) => {
          const reason = e instanceof Error ? e.message : 'unknown reason';
          resolve({ err: `couldn't get a new websocket: ${reason}` });
        });
    });

    if ('ws' in wsRes) {
      const conn = new WebSocketConnection(wsRes.ws);
      log?.info(`raw websocket to ${to} ok, starting handshake`, {
        clientId: this.clientId,
        connectedTo: to,
      });

      this.handleConnection(conn, to);
      return conn;
    } else {
      throw new Error(wsRes.err);
    }
  }
}
