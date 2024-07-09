import { Connection } from '../connection';
import { OpaqueTransportMessage, TransportMessage } from '../message';
import {
  IdentifiedSession,
  IdentifiedSessionProps,
  SessionState,
} from './common';

export interface SessionHandshakingListeners {
  onConnectionErrored: (err: unknown) => void;
  onConnectionClosed: () => void;
  onHandshake: (msg: OpaqueTransportMessage) => void;
  onInvalidHandshake: (reason: string) => void;

  // timeout related
  onHandshakeTimeout: () => void;
}

export interface SessionHandshakingProps<ConnType extends Connection>
  extends IdentifiedSessionProps {
  conn: ConnType;
  listeners: SessionHandshakingListeners;
}

/*
 * A session that is handshaking and waiting for the other side to identify itself.
 *
 * Valid transitions:
 * - Handshaking -> NoConnection (on close)
 * - Handshaking -> Connected (on handshake)
 */
export class SessionHandshaking<
  ConnType extends Connection,
> extends IdentifiedSession {
  readonly state = SessionState.Handshaking as const;
  conn: ConnType;
  listeners: SessionHandshakingListeners;

  handshakeTimeout: ReturnType<typeof setTimeout>;

  constructor(props: SessionHandshakingProps<ConnType>) {
    super(props);
    this.conn = props.conn;
    this.listeners = props.listeners;

    this.handshakeTimeout = setTimeout(() => {
      this.listeners.onHandshakeTimeout();
    }, this.options.handshakeTimeoutMs);

    this.conn.addDataListener(this.onHandshakeData);
    this.conn.addErrorListener(this.listeners.onConnectionErrored);
    this.conn.addCloseListener(this.listeners.onConnectionClosed);
  }

  onHandshakeData = (msg: Uint8Array) => {
    const parsedMsg = this.parseMsg(msg);
    if (parsedMsg === null) {
      this.listeners.onInvalidHandshake('could not parse message');
      return;
    }

    this.listeners.onHandshake(parsedMsg);
  };

  sendHandshake(msg: TransportMessage): boolean {
    return this.conn.send(this.options.codec.toBuffer(msg));
  }

  _handleStateExit(): void {
    super._handleStateExit();
    this.conn.removeDataListener(this.onHandshakeData);
    this.conn.removeErrorListener(this.listeners.onConnectionErrored);
    this.conn.removeCloseListener(this.listeners.onConnectionClosed);
    clearTimeout(this.handshakeTimeout);
  }

  _handleClose(): void {
    super._handleClose();
    this.conn.close();
  }
}
