import { Static } from '@sinclair/typebox';
import { MessageMetadata } from '../../logging';
import { Connection } from '../connection';
import {
  HandshakeErrorResponseCodes,
  OpaqueTransportMessage,
  TransportMessage,
} from '../message';
import { CommonSession, CommonSessionProps, SessionState } from './common';

export interface SessionWaitingForHandshakeListeners {
  onConnectionErrored: (err: unknown) => void;
  onConnectionClosed: () => void;
  onHandshake: (msg: OpaqueTransportMessage) => void;
  onInvalidHandshake: (
    reason: string,
    code: Static<typeof HandshakeErrorResponseCodes>,
  ) => void;

  // timeout related
  onHandshakeTimeout: () => void;
}

export interface SessionWaitingForHandshakeProps<ConnType extends Connection>
  extends CommonSessionProps {
  conn: ConnType;
  listeners: SessionWaitingForHandshakeListeners;
}

/*
 * Server-side session that has a connection but is waiting for the client to identify itself.
 * See transitions.ts for valid transitions.
 */
export class SessionWaitingForHandshake<
  ConnType extends Connection,
> extends CommonSession {
  readonly state = SessionState.WaitingForHandshake as const;
  conn: ConnType;
  listeners: SessionWaitingForHandshakeListeners;

  handshakeTimeout?: ReturnType<typeof setTimeout>;

  constructor(props: SessionWaitingForHandshakeProps<ConnType>) {
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

  get loggingMetadata() {
    return {
      clientId: this.from,
      connId: this.conn.id,
      ...this.conn.loggingMetadata,
    };
  }

  onHandshakeData = (msg: Uint8Array) => {
    const parsedMsg = this.parseMsg(msg);
    if (parsedMsg === null) {
      this.listeners.onInvalidHandshake(
        'could not parse message',
        'MALFORMED_HANDSHAKE',
      );
      return;
    }

    // after this fires, the listener is responsible for transitioning the session
    // and thus removing the handshake timeout
    this.listeners.onHandshake(parsedMsg);
  };

  sendHandshake(msg: TransportMessage): boolean {
    return this.conn.send(this.options.codec.toBuffer(msg));
  }

  _handleStateExit(): void {
    this.conn.removeDataListener(this.onHandshakeData);
    this.conn.removeErrorListener(this.listeners.onConnectionErrored);
    this.conn.removeCloseListener(this.listeners.onConnectionClosed);
    clearTimeout(this.handshakeTimeout);
    this.handshakeTimeout = undefined;
  }

  _handleClose(): void {
    this.conn.close();
  }
}
