import WebSocket from 'isomorphic-ws';
import { Transport } from '../../transport';
import { NaiveJsonCodec } from '../../../codec/json';
import { TransportClientId } from '../../message';
import { log } from '../../../logging';
import { type Codec } from '../../../codec';
import { WebSocketConnection } from './connection';

interface Options {
  retryIntervalMs: number;
  retryAttemptsMax: number;
  codec: Codec;
}

export const DEFAULT_WS_RETRY_INTERVAL_MS = 250;
const defaultOptions: Options = {
  retryIntervalMs: DEFAULT_WS_RETRY_INTERVAL_MS,
  retryAttemptsMax: 5,
  codec: NaiveJsonCodec,
};

type WebSocketResult = { ws: WebSocket } | { err: string };

/**
 * A transport implementation that uses a WebSocket connection with automatic reconnection.
 * @class
 * @extends Transport
 */
export class WebSocketClientTransport extends Transport<WebSocketConnection> {
  /**
   * A function that returns a Promise that resolves to a WebSocket instance.
   */
  wsGetter: (to: TransportClientId) => Promise<WebSocket>;
  options: Options;
  serverId: TransportClientId;
  reconnectPromises: Map<TransportClientId, Promise<WebSocketResult>>;
  tryReconnecting: boolean = true;

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
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, sessionId);
    this.wsGetter = wsGetter;
    this.serverId = serverId;
    this.options = options;
    this.reconnectPromises = new Map();

    // eagerly connect as soon as we initialize
    this.createNewConnection(this.serverId);
  }

  reopen() {
    if (this.state === 'destroyed') {
      throw new Error('cant reopen a destroyed connection');
    }

    this.state = 'open';
    this.createNewConnection(this.serverId);
  }

  async createNewConnection(to: string, attempt = 0) {
    if (this.state === 'destroyed') {
      throw new Error('cant reopen a destroyed connection');
    }

    let reconnectPromise = this.reconnectPromises.get(to);
    if (!reconnectPromise) {
      if (!this.tryReconnecting) {
        log?.info(
          `${this.clientId} -- tryReconnecting is false, not attempting reconnect`,
        );
        return;
      }

      reconnectPromise = new Promise<WebSocketResult>(async (resolve) => {
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

      this.reconnectPromises.set(to, reconnectPromise);
    }

    const res = await reconnectPromise;

    if (this.state !== 'open') {
      this.reconnectPromises.delete(to);
      if ('ws' in res) {
        res.ws.close();
      }

      return;
    }

    if ('ws' in res && res.ws.readyState === res.ws.OPEN) {
      const existingWs = this.sessions.get(to)?.connection?.ws;
      if (res.ws === existingWs) {
        // this is our current connection
        // we reach this state when createNewConnection is called multiple times
        // concurrently
        return;
      }

      const conn = new WebSocketConnection(res.ws);
      log?.info(`${this.clientId} -- websocket (id: ${conn.id}) to ${to} ok`);
      this.onConnect(conn, to);
      conn.onData((data) => this.handleMsg(this.parseMsg(data)));
      res.ws.onclose = () => {
        this.reconnectPromises.delete(to);
        log?.info(
          `${this.clientId} -- websocket (id: ${conn.id}) to ${to} disconnected`,
        );
        this.onDisconnect(conn, to);
      };

      res.ws.onerror = (msg) => {
        log?.warn(
          `${this.clientId} -- websocket (id: ${conn.id}) to ${to} had an error: ${msg}`,
        );
      };

      this.state = 'open';
      return;
    }

    // otherwise try and reconnect again
    this.reconnectPromises.delete(to);
    if (attempt >= this.options.retryAttemptsMax) {
      throw new Error(
        `${this.clientId} -- websocket to ${to} failed after ${attempt} attempts, giving up`,
      );
    } else {
      // linear backoff
      const backoffMs = this.options.retryIntervalMs * attempt;
      log?.warn(
        `${this.clientId} -- websocket to ${to} failed, trying again in ${backoffMs}ms`,
      );
      setTimeout(() => this.createNewConnection(to, attempt + 1), backoffMs);
    }
  }

  async close() {
    super.close();
    this.reconnectPromises.clear();
  }

  async destroy() {
    super.destroy();
    this.reconnectPromises.clear();
  }
}
