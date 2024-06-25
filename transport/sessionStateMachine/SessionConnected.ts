import { PartialTransportMessage } from '../message';
import { Connection } from '../session';
import {
  IdentifiedSession,
  SessionConnectedListeners,
  SessionState,
} from './common';

export class SessionConnected<
  ConnType extends Connection,
> extends IdentifiedSession {
  readonly state = SessionState.Connected as const;
  conn: ConnType;
  listeners: SessionConnectedListeners;

  updateBookkeeping(ack: number, seq: number) {
    if (seq + 1 < this.ack) {
      this.log?.error(`received stale seq ${seq} + 1 < ${this.ack}`, {
        ...this.loggingMetadata,
        tags: ['invariant-violation'],
      });
      return;
    }

    this.sendBuffer = this.sendBuffer.filter((unacked) => unacked.seq >= ack);
    this.ack = seq + 1;
  }

  send(msg: PartialTransportMessage): string {
    const constructedMsg = this.constructMsg(msg);
    this.sendBuffer.push(constructedMsg);
    this.conn.send(this.options.codec.toBuffer(constructedMsg));
    return constructedMsg.id;
  }

  constructor(
    conn: ConnType,
    listeners: SessionConnectedListeners,
    ...args: ConstructorParameters<typeof IdentifiedSession>
  ) {
    super(...args);
    this.conn = conn;
    this.listeners = listeners;

    this.conn.addDataListener(this.onMessageData);
    this.conn.addCloseListener(listeners.onConnectionClosed);
    this.conn.addErrorListener(listeners.onConnectionErrored);

    // send any buffered messages
    for (const msg of this.sendBuffer) {
      conn.send(this.options.codec.toBuffer(msg));
    }
  }

  onMessageData = (msg: Uint8Array) => {
    const parsedMsg = this.parseMsg(msg);
    if (parsedMsg === null) return;

    this.updateBookkeeping(parsedMsg.ack, parsedMsg.seq);
    this.listeners.onMessage(parsedMsg);
  };

  _onStateExit(): void {
    super._onStateExit();
    this.conn.removeDataListener(this.onMessageData);
    this.conn.removeCloseListener(this.listeners.onConnectionClosed);
    this.conn.removeErrorListener(this.listeners.onConnectionErrored);
  }

  _onClose(): void {
    super._onClose();
    this.conn.close();
  }
}
