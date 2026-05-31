import type { Static } from 'typebox';
import {
  ControlFlags,
  ControlMessageAckSchema,
  EncodedTransportMessage,
  OpaqueTransportMessage,
  PartialTransportMessage,
  RehandshakeStreamId,
  rehandshakeRequestMessage,
  isAck,
} from '../message';
import {
  IdentifiedSession,
  IdentifiedSessionListeners,
  IdentifiedSessionProps,
  SessionState,
} from './common';
import { Connection } from '../connection';
import { SpanStatusCode } from '@opentelemetry/api';
import { SendBufferResult, SendResult } from '../results';

export interface SessionConnectedListeners extends IdentifiedSessionListeners {
  onConnectionErrored: (err: unknown) => void;
  onConnectionClosed: () => void;
  onMessage: (msg: OpaqueTransportMessage) => void;
  /**
   * A frame arrived on the reserved re-handshake stream. The transport consumes
   * it to drive the follow-up handshake rather than surfacing it to the router.
   */
  onRehandshake: (msg: OpaqueTransportMessage) => void;
  /**
   * A scheduled re-handshake went unanswered within its deadline. Only the server
   * arms this (via {@link SessionConnected.scheduleRehandshake}); it tears the
   * session down rather than keep serving a credential past its expiry.
   */
  onRehandshakeTimeout?: () => void;
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
  private rehandshakeTimer?: ReturnType<typeof setTimeout> | undefined;
  private credentialExpiry?: number | undefined;

  updateBookkeeping(ack: number, seq: number) {
    this.sendBuffer = this.sendBuffer.filter((unacked) => unacked.seq >= ack);
    this.ack = seq + 1;

    if (this.heartbeatMissTimeout) {
      clearTimeout(this.heartbeatMissTimeout);
    }

    this.startMissingHeartbeatTimeout();
  }

  private assertSendOrdering(encodedMsg: EncodedTransportMessage) {
    if (encodedMsg.seq > this.seqSent + 1) {
      const msg = `invariant violation: would have sent out of order msg (seq: ${encodedMsg.seq}, expected: ${this.seqSent} + 1)`;
      this.log?.error(msg, {
        ...this.loggingMetadata,
        tags: ['invariant-violation'],
      });

      throw new Error(msg);
    }
  }

  send(msg: PartialTransportMessage): SendResult {
    const encodeResult = this.encodeMsg(msg);
    if (!encodeResult.ok) {
      return encodeResult;
    }

    const encodedMsg = encodeResult.value;
    this.assertSendOrdering(encodedMsg);
    this.sendBuffer.push(encodedMsg);

    const sent = this.conn.send(encodedMsg.data);
    if (!sent) {
      const reason = 'failed to send message';
      this.listeners.onMessageSendFailure(
        { ...encodedMsg.msg, seq: encodedMsg.seq },
        reason,
      );

      return { ok: false, reason };
    }

    this.seqSent = encodedMsg.seq;

    return { ok: true, value: encodedMsg.id };
  }

  constructor(props: SessionConnectedProps<ConnType>) {
    super(props);
    this.conn = props.conn;
    this.listeners = props.listeners;

    this.conn.setDataListener(this.onMessageData);
    this.conn.setCloseListener(this.listeners.onConnectionClosed);
    this.conn.setErrorListener(this.listeners.onConnectionErrored);
  }

  sendBufferedMessages(): SendBufferResult {
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

        const sent = this.conn.send(msg.data);
        if (!sent) {
          const reason = 'failed to send buffered message';
          this.listeners.onMessageSendFailure(
            { ...msg.msg, seq: msg.seq },
            reason,
          );

          return { ok: false, reason };
        }

        this.seqSent = msg.seq;
      }
    }

    return { ok: true, value: undefined };
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

  /**
   * Schedules the next proactive re-handshake from the credential's expiry. The
   * server calls this after each (re)validation, mirroring {@link startActiveHeartbeat}:
   * once armed the session drives the exchange itself — one handshake window before
   * expiry it sends a re-handshake request and waits for the response, firing
   * {@link SessionConnectedListeners.onRehandshakeTimeout} if none arrives in time.
   * Passing `undefined` (a credential that never expires) cancels any schedule.
   */
  scheduleRehandshake(expiry: number | undefined) {
    this.clearRehandshakeTimer();
    this.credentialExpiry = expiry;
    if (expiry === undefined) {
      return;
    }

    // re-handshake one window before expiry so the exchange resolves (a refresh
    // lands, or the deadline below tears the session down) by the time it expires
    const delayMs = expiry - this.options.handshakeTimeoutMs - Date.now();
    this.rehandshakeTimer = setTimeout(
      () => {
        this.rehandshakeTimer = undefined;
        this.sendRehandshakeRequest();
      },
      Math.max(0, delayMs),
    );
  }

  /**
   * Sends a re-handshake request immediately and arms the response deadline,
   * bypassing the expiry schedule. Returns false if the request couldn't be sent.
   */
  requestRehandshakeNow(): boolean {
    this.clearRehandshakeTimer();

    return this.sendRehandshakeRequest();
  }

  private sendRehandshakeRequest(): boolean {
    const res = this.send(rehandshakeRequestMessage());
    if (!res.ok) {
      // the send failure already tore the session down via onMessageSendFailure
      return false;
    }

    // clamp the deadline to the credential's remaining life, so one validated with
    // little time left is still torn down by expiry rather than a full window later
    const deadlineMs =
      this.credentialExpiry !== undefined
        ? Math.min(
            this.options.handshakeTimeoutMs,
            this.credentialExpiry - Date.now(),
          )
        : this.options.handshakeTimeoutMs;
    this.rehandshakeTimer = setTimeout(
      () => {
        this.rehandshakeTimer = undefined;
        this.listeners.onRehandshakeTimeout?.();
      },
      Math.max(0, deadlineMs),
    );

    return true;
  }

  clearRehandshakeTimer() {
    if (this.rehandshakeTimer) {
      clearTimeout(this.rehandshakeTimer);
      this.rehandshakeTimer = undefined;
    }
  }

  onMessageData = (msg: Uint8Array) => {
    const parsedMsgRes = this.codec.fromBuffer(msg);
    if (!parsedMsgRes.ok) {
      this.listeners.onInvalidMessage(
        `could not parse message: ${parsedMsgRes.reason}`,
      );

      return;
    }

    const parsedMsg = parsedMsgRes.value;

    // messages must originate from this session's peer
    if (parsedMsg.from !== this.to) {
      this.listeners.onInvalidMessage(
        `received message with 'from' (${parsedMsg.from}) that does not match the session peer (${this.to})`,
      );

      return;
    }

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
      // re-handshake frames ride a reserved stream and are consumed by the
      // transport, never surfaced to the router (same as the acks handled below)
      if (parsedMsg.streamId === RehandshakeStreamId) {
        this.listeners.onRehandshake(parsedMsg);

        return;
      }

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
    this.conn.removeDataListener();
    this.conn.removeCloseListener();
    this.conn.removeErrorListener();

    if (this.heartbeatHandle) {
      clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = undefined;
    }

    if (this.heartbeatMissTimeout) {
      clearTimeout(this.heartbeatMissTimeout);
      this.heartbeatMissTimeout = undefined;
    }

    this.clearRehandshakeTimer();
  }

  _handleClose(): void {
    super._handleClose();
    this.conn.close();
  }
}
