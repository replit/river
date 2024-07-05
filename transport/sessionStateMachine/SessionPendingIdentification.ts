import { MessageMetadata } from '../../logging';
import { Connection } from '../connection';
import { TransportMessage } from '../message';
import { SessionHandshakingListeners } from './SessionHandshaking';
import { CommonSession, SessionState } from './common';

/*
 * Server-side session that has a connection but is waiting for the client to identify itself.
 *
 * Valid transitions:
 * - PendingIdentification -> NoConnection (on close)
 * - PendingIdentification -> Connected (on handshake)
 */
export class SessionPendingIdentification<
  ConnType extends Connection,
> extends CommonSession {
  readonly state = SessionState.PendingIdentification as const;
  conn: ConnType;
  listeners: SessionHandshakingListeners;

  handshakeTimeout: ReturnType<typeof setTimeout>;

  constructor(
    conn: ConnType,
    listeners: SessionHandshakingListeners,
    ...args: ConstructorParameters<typeof CommonSession>
  ) {
    super(...args);
    this.conn = conn;
    this.listeners = listeners;

    this.handshakeTimeout = setTimeout(() => {
      listeners.onHandshakeTimeout();
    }, this.options.handshakeTimeoutMs);

    this.conn.addDataListener(this.onHandshakeData);
    this.conn.addErrorListener(listeners.onConnectionErrored);
    this.conn.addCloseListener(listeners.onConnectionClosed);
  }

  onHandshakeData = (msg: Uint8Array) => {
    const parsedMsg = this.parseMsg(msg);
    if (parsedMsg === null) {
      this.listeners.onInvalidHandshake('could not parse message');
      return;
    }

    this.listeners.onHandshake(parsedMsg);
  };

  get loggingMetadata(): MessageMetadata {
    return {
      clientId: this.from,
      connId: this.conn.id,
    };
  }

  sendHandshake(msg: TransportMessage): boolean {
    return this.conn.send(this.options.codec.toBuffer(msg));
  }

  _handleStateExit(): void {
    this.conn.removeDataListener(this.onHandshakeData);
    this.conn.removeErrorListener(this.listeners.onConnectionErrored);
    this.conn.removeCloseListener(this.listeners.onConnectionClosed);
    clearTimeout(this.handshakeTimeout);
  }

  _handleClose(): void {
    this.conn.close();
  }
}
