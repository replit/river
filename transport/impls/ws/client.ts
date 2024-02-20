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
   * @param sessionId The ID of the client using the transport. This should be unique per session.
   * @param serverId The ID of the server this transport is connecting to.
   * @param providedOptions An optional object containing configuration options for the transport.
   */
  constructor(
    wsGetter: () => Promise<WebSocket>,
    sessionId: TransportClientId,
    serverId: TransportClientId,
    providedOptions?: Partial<TransportOptions>,
  ) {
    super(sessionId, providedOptions);
    this.wsGetter = wsGetter;
    this.serverId = serverId;

    // eagerly connect as soon as we initialize
    this.connect(this.serverId);
  }

  reopen() {
    if (this.state === 'destroyed') {
      throw new Error('cant reopen a destroyed connection');
    }

    this.state = 'open';
    this.connect(this.serverId);
  }

  async createNewOutgoingConnection(to: string) {
    // get a promise to an actual websocket that's ready
    const wsRes = await new Promise<WebSocketResult>(async (resolve) => {
      log?.info(`${this.clientId} -- establishing a new websocket to ${to}`);
      try {
        const ws = await this.wsGetter(to);
        if (ws.readyState === ws.OPEN) {
          return resolve({ ws });
        }

        if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) {
          return resolve({ err: 'ws is closing or closed' });
        }

        const onOpen = () => {
          ws.removeEventListener('open', onOpen);
          resolve({ ws });
        };

        const onClose = (evt: WebSocket.CloseEvent) => {
          ws.removeEventListener('close', onClose);
          resolve({ err: evt.reason });
        };

        ws.addEventListener('open', onOpen);
        ws.addEventListener('close', onClose);
      } catch (e) {
        const reason = e instanceof Error ? e.message : 'unknown reason';
        return resolve({ err: `couldn't get a new websocket: ${reason}` });
      }
    });

    if ('ws' in wsRes) {
      const conn = new WebSocketConnection(wsRes.ws);
      log?.info(
        `${this.clientId} -- websocket (id: ${conn.debugId}) to ${to} ok`,
      );
      this.onConnect(conn, to);
      conn.addDataListener((data) => this.handleMsg(this.parseMsg(data)));
      wsRes.ws.onclose = () => {
        log?.info(
          `${this.clientId} -- websocket (id: ${conn.debugId}) to ${to} disconnected`,
        );
        this.onDisconnect(conn, to);
        this.connect(to);
      };

      wsRes.ws.onerror = (msg) => {
        log?.warn(
          `${this.clientId} -- websocket (id: ${conn.debugId}) to ${to} had an error: ${msg}`,
        );
      };

      return conn;
    } else {
      throw new Error(wsRes.err);
    }
  }

  async close() {
    super.close();
  }

  async destroy() {
    super.destroy();
  }
}
