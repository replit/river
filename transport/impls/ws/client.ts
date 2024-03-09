import WebSocket from 'isomorphic-ws';
import { ClientTransport, TransportOptions } from '../../transport';
import { TransportClientId } from '../../message';
import { log } from '../../../logging';
import { WebSocketConnection } from './connection';

type WebSocketResult = { ws: WebSocket } | { err: string };

/**
 * A transport implementation that uses a WebSocket connection with automatic reconnection.
 * @class
 * @extends Transport
 */
export class WebSocketClientTransport extends ClientTransport<WebSocketConnection> {
  /**
   * A function that returns a Promise that resolves to a WebSocket instance.
   */
  wsGetter: (to: TransportClientId) => Promise<WebSocket>;
  serverId: TransportClientId;

  /**
   * Creates a new WebSocketClientTransport instance.
   * @param wsGetter A function that returns a Promise that resolves to a WebSocket instance.
   * @param clientId The ID of the client using the transport. This should be unique per session.
   * @param serverId The ID of the server this transport is connecting to.
   * @param providedOptions An optional object containing configuration options for the transport.
   */
  constructor(
    wsGetter: () => Promise<WebSocket>,
    clientId: TransportClientId,
    serverId: TransportClientId,
    providedOptions?: Partial<TransportOptions>,
  ) {
    super(clientId, serverId, providedOptions);
    this.wsGetter = wsGetter;
    this.serverId = serverId;

    // eagerly connect as soon as we initialize
    void this.connect(this.serverId);
  }

  reopen() {
    if (this.state === 'destroyed') {
      throw new Error('cant reopen a destroyed connection');
    }

    this.state = 'open';
    void this.connect(this.serverId);
  }

  async createNewOutgoingConnection(to: string) {
    // get a promise to an actual websocket that's ready
    const wsRes = await new Promise<WebSocketResult>((resolve) => {
      log?.info(`${this.clientId} -- establishing a new websocket to ${to}`);
      this.wsGetter(to)
        .then((ws) => {
          if (ws.readyState === ws.OPEN) {
            resolve({ ws });
            return;
          }

          if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) {
            resolve({ err: 'ws is closing or closed' });
            return;
          }

          ws.onopen = () => {
            resolve({ ws });
          };

          ws.onclose = (evt: WebSocket.CloseEvent) => {
            resolve({ err: evt.reason });
          };

          ws.onerror = (evt: WebSocket.ErrorEvent) => {
            const err = evt.error as { code: string } | undefined;
            resolve({
              err: err?.code ?? 'unexpected disconnect',
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
      log?.info(
        `${this.clientId} -- websocket (id: ${conn.debugId}) to ${to} ok`,
      );
      this.handleConnection(conn, to);
      return conn;
    } else {
      throw new Error(wsRes.err);
    }
  }
}
