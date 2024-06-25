import { MessageMetadata } from '../../logging';
import { TransportMessage } from '../message';
import { Connection } from '../session';
import {
  CommonSession,
  SessionHandshakingListeners,
  SessionState,
} from './common';

export class SessionPendingIdentification<
  ConnType extends Connection,
> extends CommonSession {
  readonly state = SessionState.PendingIdentification as const;
  conn: ConnType;
  listeners: SessionHandshakingListeners;

  constructor(
    conn: ConnType,
    listeners: SessionHandshakingListeners,
    ...args: ConstructorParameters<typeof CommonSession>
  ) {
    super(...args);
    this.conn = conn;
    this.listeners = listeners;
  }

  get loggingMetadata(): MessageMetadata {
    return {
      clientId: this.from,
      connId: this.conn.id,
    };
  }

  sendHandshake(msg: TransportMessage): boolean {
    return this.conn.send(this.options.codec.toBuffer(msg));
  }

  _onStateExit(): void {
    // noop
  }

  _onClose(): void {
    this.conn.close();
  }
}
