import { TransportMessage } from '../message';
import { Connection } from '../session';
import {
  IdentifiedSession,
  SessionHandshakingListeners,
  SessionState,
} from './common';

export class SessionHandshaking<
  ConnType extends Connection,
> extends IdentifiedSession {
  readonly state = SessionState.Handshaking as const;
  conn: ConnType;
  listeners: SessionHandshakingListeners;

  handshakeTimeout: ReturnType<typeof setTimeout>;

  constructor(
    conn: ConnType,
    listeners: SessionHandshakingListeners,
    ...args: ConstructorParameters<typeof IdentifiedSession>
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
    if (parsedMsg === null) return;

    this.listeners.onHandshake(parsedMsg);
  };

  sendHandshake(msg: TransportMessage): boolean {
    return this.conn.send(this.options.codec.toBuffer(msg));
  }

  _onStateExit(): void {
    super._onStateExit();
    this.conn.removeDataListener(this.onHandshakeData);
    this.conn.removeErrorListener(this.listeners.onConnectionErrored);
    this.conn.removeCloseListener(this.listeners.onConnectionClosed);
    clearTimeout(this.handshakeTimeout);
  }

  _onClose(): void {
    super._onClose();
    this.conn.close();
  }
}
