import WebSocket from 'isomorphic-ws';
import { Transport } from '../types';
import { NaiveJsonCodec } from '../../codec/json';
import {
  MessageId,
  OpaqueTransportMessage,
  TransportClientId,
} from '../message';
import { log } from '../../logging';
import { type Codec } from '../../codec';

interface Options {
  retryIntervalMs: number;
  codec: Codec;
  binaryType: 'arraybuffer';
}

const defaultOptions: Options = {
  retryIntervalMs: 250,
  codec: NaiveJsonCodec,
  binaryType: 'arraybuffer',
};

type WebSocketResult = { ws: WebSocket } | { err: string };

/**
 * A transport implementation that uses a WebSocket connection with automatic reconnection.
 * @class
 * @extends Transport
 */
export class WebSocketClientTransport extends Transport {
  /**
   * A function that returns a Promise that resolves to a WebSocket instance.
   */
  wsGetter: () => Promise<WebSocket>;
  ws?: WebSocket;
  options: Options;

  /**
   * A flag indicating whether the transport has been destroyed.
   * A destroyed transport will not attempt to reconnect and cannot be used again.
   */
  state: 'open' | 'closed' | 'destroyed';

  /**
   * The binary type of the WebSocket connection.
   */
  binaryType: 'arraybuffer';

  /**
   * An ongoing reconnect attempt if it exists. When the attempt finishes, it contains a
   * {@link WebSocketResult} object when a connection is established or an error occurs.
   */
  reconnectPromise?: Promise<WebSocketResult>;

  /**
   * An array of message IDs that are waiting to be sent over the WebSocket connection.
   * This builds up if the WebSocket is down for a period of time.
   */
  sendQueue: Array<MessageId>;

  /**
   * Creates a new WebSocketTransport instance.
   * @param wsGetter A function that returns a Promise that resolves to a WebSocket instance.
   * @param clientId The ID of the client using the transport.
   * @param providedOptions An optional object containing configuration options for the transport.
   */
  constructor(
    wsGetter: () => Promise<WebSocket>,
    clientId: TransportClientId,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);
    this.state = 'open';
    this.binaryType = options.binaryType;
    this.wsGetter = wsGetter;
    this.options = options;
    this.sendQueue = [];
    this.tryConnect();
  }

  /**
   * Begins a new attempt to establish a WebSocket connection.
   */
  private async tryConnect() {
    if (this.state !== 'open') {
      return;
    }

    // wait until it's ready or we get an error
    this.reconnectPromise ??= new Promise<WebSocketResult>(async (resolve) => {
      log?.info(`${this.clientId} -- establishing a new websocket`);
      const ws = await this.wsGetter();
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

      ws.addEventListener('error', function onError(err) {
        ws.removeEventListener('error', onError);
        resolve({ err: err.message });
      });

      ws.addEventListener('close', function onClose(evt) {
        ws.removeEventListener('close', onClose);
        resolve({ err: evt.reason });
      });
    });
    const res = await this.reconnectPromise;

    // only send if we resolved a valid websocket
    if ('ws' in res && res.ws.readyState === res.ws.OPEN) {
      log?.info(`${this.clientId} -- websocket ok`);

      this.ws = res.ws;
      this.ws.binaryType = this.options.binaryType;
      this.ws.onmessage = (msg) => this.onMessage(msg.data as Uint8Array);
      this.ws.onclose = () => {
        this.reconnectPromise = undefined;
        this.tryConnect().catch();
      };

      // send outstanding
      for (const id of this.sendQueue) {
        const msg = this.sendBuffer.get(id);
        if (!msg) {
          const err = 'tried to resend a message we received an ack for';
          log?.error(err);
          throw new Error(err);
        }

        log?.info(`${this.clientId} -- sending ${JSON.stringify(msg)}`);
        this.ws.send(this.codec.toBuffer(msg));
      }

      this.sendQueue = [];
      return;
    }

    // otherwise try and reconnect again
    log?.warn(
      `${this.clientId} -- websocket failed, trying again in ${this.options.retryIntervalMs}ms`,
    );
    this.reconnectPromise = undefined;
    setTimeout(() => this.tryConnect(), this.options.retryIntervalMs);
  }

  /**
   * Sends a message over the WebSocket connection. If the WebSocket connection is
   * not healthy, it will queue until the connection is successful.
   * @param msg The message to send.
   * @returns The ID of the sent message.
   */
  send(msg: OpaqueTransportMessage): MessageId {
    const id = msg.id;
    if (this.state === 'destroyed') {
      const err = 'ws is destroyed, cant send';
      log?.error(err + `: ${JSON.stringify(msg)}`);
      throw new Error(err);
    } else if (this.state === 'closed') {
      log?.info(`ws is closed, discarding msg: ${JSON.stringify(msg)}`);
      return msg.id;
    }

    this.sendBuffer.set(id, msg);
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      log?.info(`${this.clientId} -- sending ${JSON.stringify(msg)}`);
      this.ws.send(this.codec.toBuffer(msg));
    } else {
      log?.info(
        `${this.clientId} -- transport not ready, queuing ${JSON.stringify(
          msg,
        )}`,
      );
      this.sendQueue.push(id);
      this.tryConnect().catch();
    }

    return id;
  }

  /**
   * Closes the WebSocket transport. Any messages sent while the transport is closed will be silently discarded.
   */
  async close() {
    log?.info('closed ws transport');
    this.state = 'closed';
    return this.ws?.close();
  }

  /**
   * Destroys the WebSocket transport. Any messages sent while the transport is closed will throw an error.
   */
  async destroy() {
    log?.info('destroyed ws transport');
    this.state = 'destroyed';
    return this.ws?.close();
  }
}
