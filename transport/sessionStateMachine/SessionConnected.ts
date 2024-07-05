import { Static } from '@sinclair/typebox';
import {
  ControlFlags,
  ControlMessageAckSchema,
  OpaqueTransportMessage,
  PartialTransportMessage,
  isAck,
} from '../message';
import { IdentifiedSession, SessionState } from './common';
import { Connection } from '../connection';
import { SpanStatusCode } from '@opentelemetry/api';

export interface SessionConnectedListeners {
  onConnectionErrored: (err: unknown) => void;
  onConnectionClosed: () => void;
  onMessage: (msg: OpaqueTransportMessage) => void;
  onInvalidMessage: (reason: string) => void;
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
    if (this.sendBuffer.length > 0) {
      this.log?.debug(
        `sending ${this.sendBuffer.length} buffered messages`,
        this.loggingMetadata,
      );
    }

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
      if (misses >= this.options.heartbeatsUntilDead) {
        this.log?.info(
          `closing connection to ${this.to} due to inactivity (missed ${misses} heartbeats which is ${missDuration}ms)`,
          this.loggingMetadata,
        );
        this.telemetry.span.addEvent('closing connection due to inactivity');
        this.conn.close();
        clearInterval(this.heartbeatHandle);
        this.heartbeatHandle = undefined;
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

    // check message ordering here
    if (parsedMsg.seq !== this.ack) {
      if (parsedMsg.seq < this.ack) {
        this.log?.debug(
          `received duplicate msg (got seq: ${parsedMsg.seq}, wanted seq: ${this.ack}), discarding`,
          {
            ...this.loggingMetadata,
            transportMessage: parsedMsg,
          },
        );
      } else {
        const reason = `received out-of-order msg (got seq: ${parsedMsg.seq}, wanted seq: ${this.ack})`;
        this.log?.error(reason, {
          ...this.loggingMetadata,
          transportMessage: parsedMsg,
          tags: ['invariant-violation'],
        });
        this.telemetry.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: reason,
        });

        this.listeners.onInvalidMessage(reason);
      }

      return;
    }

    // message is ok to update bookkeeping with
    this.log?.debug(`received msg`, {
      ...this.loggingMetadata,
      transportMessage: parsedMsg,
    });

    this.updateBookkeeping(parsedMsg.ack, parsedMsg.seq);

    // dispatch directly if its not an explicit ack
    if (!isAck(parsedMsg.controlFlags)) {
      this.listeners.onMessage(parsedMsg);
      return;
    }

    // discard acks (unless we aren't heartbeating in which case just respond)
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
    this.heartbeatHandle = undefined;
  }

  _handleClose(): void {
    super._handleClose();
    this.conn.close();
  }
}
