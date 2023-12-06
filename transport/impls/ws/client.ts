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

const defaultOptions: Options = {
  retryIntervalMs: 250,
  retryAttemptsMax: 5,
  codec: NaiveJsonCodec,
};

type WebSocketResult = { ws: WebSocket } | { err: string };

/**
 * A transport implementation that uses a WebSocket connection with automatic reconnection.
 * @class
 * @extends Transport
 */
export class WebSocketClientTransport extends Transport<
  WebSocketConnection<WebSocket>
> {
  /**
   * A function that returns a Promise that resolves to a WebSocket instance.
   */
  wsGetter: (to: TransportClientId) => Promise<WebSocket>;
  options: Options;
  serverId: TransportClientId;

  reconnectPromises: Map<TransportClientId, Promise<WebSocketResult>>;

  /**
   * Creates a new WebSocketTransport instance.
   * @param wsGetter A function that returns a Promise that resolves to a WebSocket instance.
   * @param clientId The ID of the client using the transport.
   * @param providedOptions An optional object containing configuration options for the transport.
   */
  constructor(
    wsGetter: () => Promise<WebSocket>,
    clientId: TransportClientId,
    serverId: TransportClientId,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);
    this.wsGetter = wsGetter;
    this.serverId = serverId;
    this.options = options;
    this.reconnectPromises = new Map();
    this.setupConnectionStatusListeners();
  }

  setupConnectionStatusListeners(): void {
    this.createNewConnection(this.serverId);
  }

  async createNewConnection(to: string, attempt = 0) {
    if (this.state === 'destroyed') {
      throw new Error('cant reopen a destroyed connection');
    }

    let reconnectPromise = this.reconnectPromises.get(to);
    if (!reconnectPromise) {
      reconnectPromise = new Promise<WebSocketResult>(async (resolve) => {
        log?.info(`${this.clientId} -- establishing a new websocket to ${to}`);
        const ws = await this.wsGetter(to);
        if (ws.readyState === ws.OPEN) {
          return resolve({ ws });
        }

        if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) {
          return resolve({ err: 'ws is closing or closed' });
        }

        ws.addEventListener('open', function onOpen() {
          ws.removeEventListener('open', onOpen);
          resolve({ ws });
        });

        ws.addEventListener('close', function onClose(evt) {
          ws.removeEventListener('close', onClose);
          resolve({ err: evt.reason });
        });
      });
      this.reconnectPromises.set(to, reconnectPromise);
    }

    const res = await reconnectPromise;
    if ('ws' in res && res.ws.readyState === res.ws.OPEN) {
      if (res.ws === this.connections.get(to)?.ws) {
        // this is our current connection
        // we reach this state when createNewConnection is called multiple times
        // concurrently
        return;
      }

      log?.info(`${this.clientId} -- websocket ok`);
      const conn = new WebSocketConnection(this, to, res.ws);
      this.onConnect(conn);
      res.ws.onclose = () => {
        this.reconnectPromises.delete(to);
        this.onDisconnect(conn);
      };
      this.state = 'open';
      return;
    }

    // otherwise try and reconnect again
    log?.warn(
      `${this.clientId} -- websocket failed, trying again in ${this.options.retryIntervalMs}ms`,
    );
    this.reconnectPromises.delete(to);
    if (attempt >= this.options.retryAttemptsMax) {
      return;
    } else {
      // linear backoff
      setTimeout(
        () => this.createNewConnection(to, attempt + 1),
        this.options.retryIntervalMs * attempt,
      );
    }
  }

  /**
   * Begins a new attempt to establish a WebSocket connection.
   */
  async open() {
    return this.createNewConnection(this.serverId);
  }
}
