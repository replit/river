import { ClientTransport } from '../../client';
import {
  type CustomHandshakeErrorCodeSchema,
  TransportClientId,
} from '../../message';
import {
  ProvidedClientTransportOptions,
  isValidWebSocketCloseCode,
} from '../../options';
import { WebSocketConnection } from './connection';
import { WsLike } from './wslike';
import { SessionState } from '../../sessionStateMachine';

export interface WebSocketClientTransportOptions
  extends ProvidedClientTransportOptions {
  /** Received close codes that end the logical session before reconnecting. */
  nonResumableCloseCodes?: ReadonlyArray<number>;
}

/**
 * A transport implementation that uses a WebSocket connection with automatic reconnection.
 * @class
 * @extends Transport
 */
export class WebSocketClientTransport<
  RejectionCodeSchema extends CustomHandshakeErrorCodeSchema = never,
> extends ClientTransport<WebSocketConnection, RejectionCodeSchema> {
  /**
   * A function that returns a Promise that resolves to a websocket URL.
   */
  wsGetter: (to: TransportClientId) => Promise<WsLike> | WsLike;
  private readonly nonResumableCloseCodes: ReadonlyArray<number>;

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
    providedOptions?: WebSocketClientTransportOptions,
  ) {
    super(clientId, providedOptions);
    const closeCode = this.options.outboundBufferLimit?.closeCode;
    if (closeCode !== undefined && closeCode !== 1000 && closeCode < 3000) {
      throw new Error(
        'outboundBufferLimit.closeCode must be 1000 or 3000-4999 for WebSocket clients',
      );
    }
    const nonResumableCloseCodes: unknown =
      providedOptions?.nonResumableCloseCodes;
    if (
      nonResumableCloseCodes !== undefined &&
      !Array.isArray(nonResumableCloseCodes)
    ) {
      throw new Error(
        'nonResumableCloseCodes must contain valid WebSocket close codes',
      );
    }
    const codes: Array<unknown> = Array.from(nonResumableCloseCodes ?? []);
    if (!codes.every(isValidWebSocketCloseCode)) {
      throw new Error(
        'nonResumableCloseCodes must contain valid WebSocket close codes',
      );
    }
    this.nonResumableCloseCodes = codes;
    this.wsGetter = wsGetter;
  }

  async createNewOutgoingConnection(to: string) {
    this.log?.info(`establishing a new websocket to ${to}`, {
      clientId: this.clientId,
      connectedTo: to,
    });

    const sessionId = this.sessions.get(to)?.id;
    const ws = await this.wsGetter(to);
    const connectingSession = this.sessions.get(to);

    await new Promise<void>((resolve, reject) => {
      if (ws.readyState === ws.OPEN) {
        resolve();

        return;
      }

      if (
        ws.readyState === ws.CLOSED ||
        (ws.readyState === ws.CLOSING &&
          this.nonResumableCloseCodes.length === 0)
      ) {
        reject(new Error('ws is closing or closed'));

        return;
      }

      ws.onopen = () => {
        resolve();
      };

      ws.onclose = (evt) => {
        reject(new Error(evt.reason));
        if (
          this.nonResumableCloseCodes.includes(evt.code) &&
          connectingSession &&
          connectingSession.id === sessionId &&
          !connectingSession._isConsumed &&
          this.sessions.get(to) === connectingSession
        ) {
          this.deleteSession(connectingSession, {
            unhealthy: true,
            nonResumable: true,
          });
          if (this.reconnectOnConnectionDrop && this.getStatus() === 'open')
            this.connect(to);
        }
      };

      ws.onerror = (err) => {
        reject(new Error(err.message));
      };
    });

    const conn = new WebSocketConnection(ws);
    if (this.nonResumableCloseCodes.length > 0) {
      const onClose = ws.onclose;
      ws.onclose = (event) => {
        const session = this.sessions.get(to);
        if (
          this.nonResumableCloseCodes.includes(event.code) &&
          session &&
          (session.state === SessionState.Connected ||
            session.state === SessionState.Handshaking) &&
          session.conn === conn
        ) {
          this.deleteSession(session, { unhealthy: true, nonResumable: true });
          conn.onClose();
          if (this.reconnectOnConnectionDrop && this.getStatus() === 'open')
            this.connect(to);

          return;
        }
        onClose?.(event);
      };
    }
    this.log?.info(`raw websocket to ${to} ok`, {
      clientId: this.clientId,
      connectedTo: to,
      ...conn.loggingMetadata,
    });

    return conn;
  }
}
