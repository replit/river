import { Static } from '@sinclair/typebox';
import {
  ControlFlags,
  ControlMessageAckSchema,
  OpaqueTransportMessage,
  PartialTransportMessage,
  isAck,
} from '../message';
import {
  IdentifiedSession,
  IdentifiedSessionProps,
  SessionState,
} from './common';
import { Connection } from '../connection';
import { SpanStatusCode } from '@opentelemetry/api';

export interface SessionConnectedListeners {
  onConnectionErrored: (err: unknown) => void;
  onConnectionClosed: () => void;
  onMessage: (msg: OpaqueTransportMessage) => void;
  onInvalidMessage: (reason: string) => void;
}

export interface SessionConnectedProps<ConnType extends Connection>
  extends IdentifiedSessionProps {
  conn: ConnType;
  listeners: SessionConnectedListeners;
}

/*
 * A session that is connected and can send and receive messages.
 * See transitions.ts for valid transitions.
 */
export class SessionConnected<
  ConnType extends Connection,
> extends IdentifiedSession {
  readonly state = SessionState.Connected as const;
  conn: ConnType;
  listeners: SessionConnectedListeners;

  private heartbeatHandle?: ReturnType<typeof setInterval> | undefined;
  private heartbeatMisses = 0;
  isActivelyHeartbeating: boolean;

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

  constructor(props: SessionConnectedProps<ConnType>) {
    super(props);
    this.conn = props.conn;
    this.listeners = props.listeners;

    this.conn.addDataListener(this.onMessageData);
    this.conn.addCloseListener(this.listeners.onConnectionClosed);
    this.conn.addErrorListener(this.listeners.onConnectionErrored);

    // send any buffered messages
    if (this.sendBuffer.length > 0) {
      this.log?.debug(
        `sending ${this.sendBuffer.length} buffered messages`,
        this.loggingMetadata,
      );
    }

    for (const msg of this.sendBuffer) {
      this.conn.send(this.options.codec.toBuffer(msg));
    }

    // dont explicity clear the buffer, we'll just filter out old messages
    // when we receive an ack

    // setup heartbeat
    this.isActivelyHeartbeating = false;
    this.heartbeatHandle = setInterval(() => {
      const misses = this.heartbeatMisses;
      const missDuration = misses * this.options.heartbeatIntervalMs;
      if (misses >= this.options.heartbeatsUntilDead) {
        this.log?.info(
          `closing connection to ${this.to} due to inactivity (missed ${misses} heartbeats which is ${missDuration}ms)`,
          this.loggingMetadata,
        );
        this.telemetry.span.addEvent('closing connection due to inactivity');

        // it is OK to close this even on the client when we can't trust the client timer
        // due to browser throttling or hibernation
        // at worst, this interval will fire later than what the server expects and the server
        // will have already closed the connection
        // this just helps us in cases where we have a proxying setup where the server has closed
        // the connection but the proxy hasn't synchronized the server-side close to the client so
        // the client isn't stuck with a pseudo-dead connection forever
        this.conn.close();
        clearInterval(this.heartbeatHandle);
        this.heartbeatHandle = undefined;
        return;
      }

      if (this.isActivelyHeartbeating) {
        this.sendHeartbeat();
      }

      this.heartbeatMisses++;
    }, this.options.heartbeatIntervalMs);
  }

  startActiveHeartbeat() {
    this.isActivelyHeartbeating = true;
  }

  private sendHeartbeat() {
    this.log?.debug('sending heartbeat', this.loggingMetadata);
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
