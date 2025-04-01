import { Static } from '@sinclair/typebox';
import {
  ControlFlags,
  ControlMessageAckSchema,
  OpaqueTransportMessage,
  PartialTransportMessage,
  TransportMessage,
  isAck,
} from '../message';
import {
  IdentifiedSession,
  IdentifiedSessionProps,
  sendMessage,
  SessionState,
} from './common';
import { Connection } from '../connection';
import { SpanStatusCode } from '@opentelemetry/api';
import { SendResult, SendErrorCode, SerializeErrorCode } from '../results';

export interface SessionConnectedListeners {
  onConnectionErrored: (err: unknown) => void;
  onConnectionClosed: () => void;
  onMessage: (msg: OpaqueTransportMessage) => void;
  onMessageSendFailure: (
    msg: PartialTransportMessage,
    code: SendErrorCode | SerializeErrorCode,
  ) => void;
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
  private heartbeatMissTimeout?: ReturnType<typeof setTimeout> | undefined;
  private isActivelyHeartbeating = false;

  updateBookkeeping(ack: number, seq: number) {
    this.sendBuffer = this.sendBuffer.filter((unacked) => unacked.seq >= ack);
    this.ack = seq + 1;

    if (this.heartbeatMissTimeout) {
      clearTimeout(this.heartbeatMissTimeout);
    }

    this.startMissingHeartbeatTimeout();
  }

  private assertSendOrdering(constructedMsg: TransportMessage) {
    if (constructedMsg.seq > this.seqSent + 1) {
      const msg = `invariant violation: would have sent out of order msg (seq: ${constructedMsg.seq}, expected: ${this.seqSent} + 1)`;
      this.log?.error(msg, {
        ...this.loggingMetadata,
        transportMessage: constructedMsg,
        tags: ['invariant-violation'],
      });

      throw new Error(msg);
    }
  }

  send(msg: PartialTransportMessage): SendResult {
    const constructedMsg = this.constructMsg(msg);
    this.assertSendOrdering(constructedMsg);
    this.sendBuffer.push(constructedMsg);
    const res = sendMessage(this.conn, this.codec, constructedMsg);
    if (!res.ok) {
      this.listeners.onMessageSendFailure(constructedMsg, res.value.code);

      return res;
    }

    this.seqSent = constructedMsg.seq;

    return res;
  }

  constructor(props: SessionConnectedProps<ConnType>) {
    super(props);
    this.conn = props.conn;
    this.listeners = props.listeners;

    this.conn.addDataListener(this.onMessageData);
    this.conn.addCloseListener(this.listeners.onConnectionClosed);
    this.conn.addErrorListener(this.listeners.onConnectionErrored);

    this.startMissingHeartbeatTimeout();
  }

  sendBufferedMessages(): void | SendResult {
    // send any buffered messages
    // dont explicity clear the buffer, we'll just filter out old messages
    // when we receive an ack
    if (this.sendBuffer.length > 0) {
      this.log?.info(
        `sending ${
          this.sendBuffer.length
        } buffered messages, starting at seq ${this.nextSeq()}`,
        this.loggingMetadata,
      );

      for (const msg of this.sendBuffer) {
        this.assertSendOrdering(msg);
        const res = sendMessage(this.conn, this.codec, msg);
        if (!res.ok) {
          this.listeners.onMessageSendFailure(msg, res.value.code);

          return res;
        }

        this.seqSent = msg.seq;
      }
    }
  }

  get loggingMetadata() {
    return {
      ...super.loggingMetadata,
      ...this.conn.loggingMetadata,
    };
  }

  startMissingHeartbeatTimeout() {
    const maxMisses = this.options.heartbeatsUntilDead;
    const missDuration = maxMisses * this.options.heartbeatIntervalMs;
    this.heartbeatMissTimeout = setTimeout(() => {
      this.log?.info(
        `closing connection to ${this.to} due to inactivity (missed ${maxMisses} heartbeats which is ${missDuration}ms)`,
        this.loggingMetadata,
      );
      this.telemetry.span.addEvent(
        'closing connection due to missing heartbeat',
      );

      this.conn.close();
    }, missDuration);
  }

  startActiveHeartbeat() {
    this.isActivelyHeartbeating = true;
    this.heartbeatHandle = setInterval(() => {
      this.sendHeartbeat();
    }, this.options.heartbeatIntervalMs);
  }

  private sendHeartbeat(): void {
    this.log?.debug('sending heartbeat', this.loggingMetadata);
    const heartbeat = {
      streamId: 'heartbeat',
      controlFlags: ControlFlags.AckBit,
      payload: {
        type: 'ACK',
      } satisfies Static<typeof ControlMessageAckSchema>,
    } satisfies PartialTransportMessage;

    this.send(heartbeat);
  }

  onMessageData = (msg: Uint8Array) => {
    const parsedMsgRes = this.codec.fromBuffer(msg);
    if (!parsedMsgRes.ok) {
      this.listeners.onInvalidMessage(
        `could not parse message: ${parsedMsgRes.value.error.message}`,
      );

      return;
    }

    const parsedMsg = parsedMsgRes.value;

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
        const reason = `received out-of-order msg, closing connection (got seq: ${parsedMsg.seq}, wanted seq: ${this.ack})`;
        this.log?.error(reason, {
          ...this.loggingMetadata,
          transportMessage: parsedMsg,
          tags: ['invariant-violation'],
        });

        this.telemetry.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: reason,
        });

        // try to recover by closing the connection and re-handshaking
        // with the session intact
        this.conn.close();
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

    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = undefined;
    }

    if (this.heartbeatMissTimeout) {
      clearTimeout(this.heartbeatMissTimeout);
      this.heartbeatMissTimeout = undefined;
    }
  }

  _handleClose(): void {
    super._handleClose();
    this.conn.close();
  }
}
