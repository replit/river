import { Static } from 'typebox';
import { Connection } from '../connection';
import {
  OpaqueTransportMessage,
  TransportMessage,
  HandshakeErrorResponseCodes,
} from '../message';
import {
  IdentifiedSessionWithGracePeriod,
  IdentifiedSessionWithGracePeriodListeners,
  IdentifiedSessionWithGracePeriodProps,
  SessionState,
} from './common';
import { SendResult } from '../results';

export interface SessionHandshakingListeners
  extends IdentifiedSessionWithGracePeriodListeners {
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

export interface SessionHandshakingProps<ConnType extends Connection>
  extends IdentifiedSessionWithGracePeriodProps {
  conn: ConnType;
  listeners: SessionHandshakingListeners;
}

/*
 * A session that is handshaking and waiting for the other side to identify itself.
 * See transitions.ts for valid transitions.
 */
export class SessionHandshaking<
  ConnType extends Connection,
> extends IdentifiedSessionWithGracePeriod {
  readonly state = SessionState.Handshaking as const;
  conn: ConnType;
  listeners: SessionHandshakingListeners;

  handshakeTimeout?: ReturnType<typeof setTimeout>;

  constructor(props: SessionHandshakingProps<ConnType>) {
    super(props);
    this.conn = props.conn;
    this.listeners = props.listeners;

    this.handshakeTimeout = setTimeout(() => {
      this.listeners.onHandshakeTimeout();
    }, this.options.handshakeTimeoutMs);

    this.conn.setDataListener(this.onHandshakeData);
    this.conn.setErrorListener(this.listeners.onConnectionErrored);
    this.conn.setCloseListener(this.listeners.onConnectionClosed);
  }

  get loggingMetadata() {
    return {
      ...super.loggingMetadata,
      ...this.conn.loggingMetadata,
    };
  }

  onHandshakeData = (msg: Uint8Array) => {
    const parsedMsgRes = this.codec.fromBuffer(msg);
    if (!parsedMsgRes.ok) {
      this.listeners.onInvalidHandshake(
        `could not parse handshake message: ${parsedMsgRes.reason}`,
        'MALFORMED_HANDSHAKE',
      );

      return;
    }

    this.listeners.onHandshake(parsedMsgRes.value);
  };

  sendHandshake(msg: TransportMessage): SendResult {
    const buff = this.codec.toBuffer(msg);
    if (!buff.ok) {
      return buff;
    }

    const sent = this.conn.send(buff.value);
    if (!sent) {
      return {
        ok: false,
        reason: 'failed to send handshake',
      };
    }

    return {
      ok: true,
      value: msg.id,
    };
  }

  _handleStateExit(): void {
    super._handleStateExit();
    this.conn.removeDataListener();
    this.conn.removeErrorListener();
    this.conn.removeCloseListener();

    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = undefined;
    }
  }

  _handleClose(): void {
    super._handleClose();
    this.conn.close();
  }
}
