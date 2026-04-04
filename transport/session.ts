import { Logger, MessageMetadata } from '../logging';
import { TelemetryInfo } from '../tracing';
import {
  EncodedTransportMessage,
  PartialTransportMessage,
  ProtocolVersion,
  TransportClientId,
  TransportMessage,
  ControlFlags,
  ControlMessageAckSchema,
  OpaqueTransportMessage,
  isAck,
} from './message';
import { CodecMessageAdapter } from '../codec';
import { generateId } from './id';
import { Tracer, SpanStatusCode } from '@opentelemetry/api';
import { EncodeResult, SendResult, SendBufferResult } from './results';
import { Connection } from './connection';
import { Static } from '@sinclair/typebox';

export const enum SessionState {
  NoConnection = 'NoConnection',
  BackingOff = 'BackingOff',
  Connecting = 'Connecting',
  Handshaking = 'Handshaking',
  Connected = 'Connected',
  WaitingForHandshake = 'WaitingForHandshake',
}

export type SessionId = string;

export interface SessionOptions {
  heartbeatIntervalMs: number;
  heartbeatsUntilDead: number;
  sessionDisconnectGraceMs: number;
  connectionTimeoutMs: number;
  handshakeTimeoutMs: number;
  enableTransparentSessionReconnects: boolean;
  codec: { toBuffer(obj: object): Uint8Array; fromBuffer(buf: Uint8Array): object };
}

export interface SessionProps {
  id: SessionId;
  from: TransportClientId;
  to: TransportClientId;
  seq: number;
  ack: number;
  seqSent: number;
  sendBuffer: EncodedTransportMessage[];
  telemetry: TelemetryInfo;
  options: SessionOptions;
  protocolVersion: ProtocolVersion;
  tracer: Tracer;
  log?: Logger;
  codec: CodecMessageAdapter;
  state: SessionState;
}

/**
 * A unified session object that replaces the old state machine class hierarchy.
 *
 * In the old architecture, sessions were polymorphic objects that transitioned
 * between classes (SessionNoConnection → SessionBackingOff → SessionConnecting →
 * SessionHandshaking → SessionConnected). Each class had its own timers, listeners,
 * and cleanup logic, guarded by a Proxy that prevented access after state transitions.
 *
 * In the new architecture, a Session is plain data. Lifecycle management (timers,
 * reconnection, heartbeats) is handled by Effection operations in the transport.
 * The session state is just a field, not a class identity.
 */
export class Session {
  readonly id: SessionId;
  readonly from: TransportClientId;
  readonly to: TransportClientId;
  readonly telemetry: TelemetryInfo;
  readonly options: SessionOptions;
  readonly protocolVersion: ProtocolVersion;
  readonly codec: CodecMessageAdapter;

  log?: Logger;
  tracer: Tracer;

  seq: number;
  ack: number;
  seqSent: number;
  sendBuffer: EncodedTransportMessage[];

  conn: Connection | null = null;
  _state: SessionState;
  _isConsumed = false;

  constructor(props: SessionProps) {
    this.id = props.id;
    this.from = props.from;
    this.to = props.to;
    this.seq = props.seq;
    this.ack = props.ack;
    this.seqSent = props.seqSent;
    this.sendBuffer = props.sendBuffer;
    this.telemetry = props.telemetry;
    this.options = props.options;
    this.protocolVersion = props.protocolVersion;
    this.tracer = props.tracer;
    this.log = props.log;
    this.codec = props.codec;
    this._state = props.state;
  }

  get state(): SessionState {
    return this._state;
  }

  get loggingMetadata(): MessageMetadata {
    const metadata: MessageMetadata = {
      clientId: this.from,
      connectedTo: this.to,
      sessionId: this.id,
    };

    if (this.telemetry.span.isRecording()) {
      const spanContext = this.telemetry.span.spanContext();
      metadata.telemetry = {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      };
    }

    if (this.conn) {
      Object.assign(metadata, this.conn.loggingMetadata);
    }

    return metadata;
  }

  encodeMsg(partialMsg: PartialTransportMessage): EncodeResult {
    const msg = {
      ...partialMsg,
      id: generateId(),
      to: this.to,
      from: this.from,
      seq: this.seq,
      ack: this.ack,
    };

    const encoded = this.codec.toBuffer(msg);
    if (!encoded.ok) {
      return encoded;
    }

    this.seq++;

    return {
      ok: true,
      value: {
        id: msg.id,
        seq: msg.seq,
        msg: partialMsg,
        data: encoded.value,
      },
    };
  }

  nextSeq(): number {
    return this.sendBuffer.length > 0 ? this.sendBuffer[0].seq : this.seq;
  }

  /**
   * Encode a message and add it to the send buffer.
   * If connected, also send over the wire immediately.
   */
  send(msg: PartialTransportMessage): SendResult {
    const encodeResult = this.encodeMsg(msg);
    if (!encodeResult.ok) {
      return encodeResult;
    }

    const encodedMsg = encodeResult.value;

    if (this.conn && this._state === SessionState.Connected) {
      // Assert send ordering when sending over the wire
      if (encodedMsg.seq > this.seqSent + 1) {
        const reason = `invariant violation: would have sent out of order msg (seq: ${encodedMsg.seq}, expected: ${this.seqSent} + 1)`;
        this.log?.error(reason, {
          ...this.loggingMetadata,
          tags: ['invariant-violation'],
        });
        throw new Error(reason);
      }

      this.sendBuffer.push(encodedMsg);
      const sent = this.conn.send(encodedMsg.data);
      if (!sent) {
        return { ok: false, reason: 'failed to send message' };
      }

      this.seqSent = encodedMsg.seq;
    } else {
      // Not connected - just buffer
      this.sendBuffer.push(encodedMsg);
    }

    return { ok: true, value: encodedMsg.id };
  }

  /**
   * Send all buffered messages over the wire. Called when a connection
   * is established or re-established.
   */
  sendBufferedMessages(): SendBufferResult {
    if (!this.conn) {
      return { ok: false, reason: 'not connected' };
    }

    if (this.sendBuffer.length > 0) {
      this.log?.info(
        `sending ${this.sendBuffer.length} buffered messages, starting at seq ${this.nextSeq()}`,
        this.loggingMetadata,
      );

      for (const msg of this.sendBuffer) {
        if (msg.seq > this.seqSent + 1) {
          const reason = `invariant violation: would have sent out of order msg (seq: ${msg.seq}, expected: ${this.seqSent} + 1)`;
          this.log?.error(reason, {
            ...this.loggingMetadata,
            tags: ['invariant-violation'],
          });
          throw new Error(reason);
        }

        const sent = this.conn.send(msg.data);
        if (!sent) {
          return { ok: false, reason: 'failed to send buffered message' };
        }

        this.seqSent = msg.seq;
      }
    }

    return { ok: true, value: undefined };
  }

  /**
   * Send a handshake message directly over the connection,
   * bypassing the normal send buffer and seq/ack tracking.
   */
  sendHandshake(msg: TransportMessage): SendResult {
    if (!this.conn) {
      return { ok: false, reason: 'not connected' };
    }

    const buff = this.codec.toBuffer(msg);
    if (!buff.ok) {
      return buff;
    }

    const sent = this.conn.send(buff.value);
    if (!sent) {
      return { ok: false, reason: 'failed to send handshake' };
    }

    return { ok: true, value: msg.id };
  }

  /**
   * Update seq/ack bookkeeping from a received message.
   * Filters acknowledged messages out of the send buffer.
   */
  updateBookkeeping(ack: number, seq: number) {
    this.sendBuffer = this.sendBuffer.filter((unacked) => unacked.seq >= ack);
    this.ack = seq + 1;
  }

  /**
   * Process an incoming raw message from the connection.
   * Returns the parsed message if it should be dispatched, or null if
   * it was handled internally (ack, duplicate, or invalid).
   *
   * @param onInvalidMessage callback for protocol-level invalid messages
   * @param isActivelyHeartbeating whether this side is actively sending heartbeats
   * @returns the parsed message to dispatch, or null
   */
  processIncomingData(
    raw: Uint8Array,
    onInvalidMessage: (reason: string) => void,
    isActivelyHeartbeating: boolean,
    onSendFailure?: (reason: string) => void,
  ): OpaqueTransportMessage | null {
    const parsedMsgRes = this.codec.fromBuffer(raw);
    if (!parsedMsgRes.ok) {
      onInvalidMessage(`could not parse message: ${parsedMsgRes.reason}`);
      return null;
    }

    const parsedMsg = parsedMsgRes.value;

    // Check message ordering
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

        // Close connection to trigger reconnection
        this.conn?.close();
      }

      return null;
    }

    // Message is valid, update bookkeeping
    this.log?.debug(`received msg`, {
      ...this.loggingMetadata,
      transportMessage: parsedMsg,
    });

    this.updateBookkeeping(parsedMsg.ack, parsedMsg.seq);

    // Handle ack messages
    if (isAck(parsedMsg.controlFlags)) {
      this.log?.debug(`discarding msg (ack bit set)`, {
        ...this.loggingMetadata,
        transportMessage: parsedMsg,
      });

      // If not actively heartbeating, respond to acks (passive mode)
      if (!isActivelyHeartbeating) {
        const res = this.sendHeartbeat();
        if (!res.ok) {
          onSendFailure?.(res.reason);
        }
      }

      return null;
    }

    return parsedMsg;
  }

  sendHeartbeat(): SendResult {
    this.log?.debug('sending heartbeat', this.loggingMetadata);
    return this.send({
      streamId: 'heartbeat',
      controlFlags: ControlFlags.AckBit,
      payload: {
        type: 'ACK',
      } satisfies Static<typeof ControlMessageAckSchema>,
    });
  }

  /**
   * Close the session, cleaning up all resources.
   * After close(), the session is consumed and should not be used.
   */
  close(): void {
    if (this._isConsumed) {
      return;
    }

    this._isConsumed = true;
    this.sendBuffer.length = 0;
    this.telemetry.span.end();
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
  }
}
