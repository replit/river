import { Static } from '@sinclair/typebox';
import {
  ControlFlags,
  ControlMessageAckSchema,
  OpaqueTransportMessage,
  PartialTransportMessage,
  isAck,
} from '../message';
import { Connection } from '../session';
import { IdentifiedSession, SessionState } from './common';

export interface SessionConnectedListeners {
  onConnectionErrored: (err: unknown) => void;
  onConnectionClosed: () => void;
  onMessage: (msg: OpaqueTransportMessage) => void;
}

/*
 * A session that is connected and can send and receive messages.
 *
 * Valid transitions:
 * - Connected -> NoConnection (on close)
 */
export class SessionConnected<
  ConnType extends Connection,
> extends IdentifiedSession {
  readonly state = SessionState.Connected as const;
  conn: ConnType;
  listeners: SessionConnectedListeners;

  heartbeatHandle?: ReturnType<typeof setInterval> | undefined;
  heartbeatMisses = 0;

  get isActivelyHeartbeating() {
    return this.heartbeatHandle !== undefined;
  }

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
    this.heartbeatMisses = 0;
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

    // dont explicity clear the buffer, we'll just filter out old messages
    // when we receive an ack
  }

  startActiveHeartbeat() {
    this.heartbeatHandle = setInterval(() => {
      const misses = this.heartbeatMisses;
      const missDuration = misses * this.options.heartbeatIntervalMs;
      if (misses > this.options.heartbeatsUntilDead) {
        this.log?.info(
          `closing connection to ${this.to} due to inactivity (missed ${misses} heartbeats which is ${missDuration}ms)`,
          this.loggingMetadata,
        );
        this.telemetry.span.addEvent('closing connection due to inactivity');
        this.conn.close();
        return;
      }

      this.sendHeartbeat();
      this.heartbeatMisses++;
    }, this.options.heartbeatIntervalMs);
  }

  private sendHeartbeat() {
    this.send({
      streamId: 'heartbeat',
      controlFlags: ControlFlags.AckBit,
      payload: {
        type: 'ACK',
      } satisfies Static<typeof ControlMessageAckSchema>,
    });
  }

  onMessageData = (msg: Uint8Array) => {
    const parsedMsg = this.parseMsg(msg);
    if (parsedMsg === null) return;

    this.updateBookkeeping(parsedMsg.ack, parsedMsg.seq);

    // dispatch directly if its not an explicit ack
    if (!isAck(parsedMsg.controlFlags)) {
      this.listeners.onMessage(parsedMsg);
      return;
    }

    // handle acks specially
    this.log?.debug(`discarding msg (ack bit set)`, {
      ...this.loggingMetadata,
      transportMessage: parsedMsg,
    });

    // if we are not actively heartbeating, we are in passive
    // heartbeat mode and should send a response to the ack
    if (!this.isActivelyHeartbeating) {
      this.sendHeartbeat();
    }
  };

  _handleStateExit(): void {
    super._handleStateExit();
    this.conn.removeDataListener(this.onMessageData);
    this.conn.removeCloseListener(this.listeners.onConnectionClosed);
    this.conn.removeErrorListener(this.listeners.onConnectionErrored);
    clearInterval(this.heartbeatHandle);
  }

  _handleClose(): void {
    super._handleClose();
    this.conn.close();
  }
}
