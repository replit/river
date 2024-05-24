import { customAlphabet } from 'nanoid';
import {
  ControlFlags,
  ControlMessageAckSchema,
  OpaqueTransportMessage,
  PartialTransportMessage,
  TransportClientId,
  TransportMessage,
} from './message';
import { Codec } from '../codec';
import { MessageMetadata, log } from '../logging/log';
import { Static } from '@sinclair/typebox';
import {
  PropagationContext,
  TelemetryInfo,
  createSessionTelemetryInfo,
} from '../tracing';
import { SpanStatusCode } from '@opentelemetry/api';

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvxyz', 6);
export const unsafeId = () => nanoid();

type SequenceNumber = number;

/**
 * A connection is the actual raw underlying transport connection.
 * It’s responsible for dispatching to/from the actual connection itself
 * This should be instantiated as soon as the client/server has a connection
 * It’s tied to the lifecycle of the underlying transport connection (i.e. if the WS drops, this connection should be deleted)
 */
export abstract class Connection {
  id: string;
  telemetry?: TelemetryInfo;
  constructor() {
    this.id = `conn-${nanoid(12)}`; // for debugging, no collision safety needed
  }

  /**
   * Handle adding a callback for when a message is received.
   * @param msg The message that was received.
   */
  abstract addDataListener(cb: (msg: Uint8Array) => void): void;
  abstract removeDataListener(cb: (msg: Uint8Array) => void): void;

  /**
   * Handle adding a callback for when the connection is closed.
   * This should also be called if an error happens.
   * @param cb The callback to call when the connection is closed.
   */
  abstract addCloseListener(cb: () => void): void;

  /**
   * Handle adding a callback for when an error is received.
   * This should only be used for logging errors, all cleanup
   * should be delegated to addCloseListener.
   *
   * The implementer should take care such that the implemented
   * connection will call both the close and error callbacks
   * on an error.
   *
   * @param cb The callback to call when an error is received.
   */
  abstract addErrorListener(cb: (err: Error) => void): void;

  /**
   * Sends a message over the connection.
   * @param msg The message to send.
   * @returns true if the message was sent, false otherwise.
   */
  abstract send(msg: Uint8Array): boolean;

  /**
   * Closes the connection.
   */
  abstract close(): void;
}

export interface SessionOptions {
  /**
   * Frequency at which to send heartbeat acknowledgements
   */
  heartbeatIntervalMs: number;
  /**
   * Number of elapsed heartbeats without a response message before we consider
   * the connection dead.
   */
  heartbeatsUntilDead: number;
  /**
   * Duration to wait between connection disconnect and actual session disconnect
   */
  sessionDisconnectGraceMs: number;
  /**
   * The codec to use for encoding/decoding messages over the wire
   */
  codec: Codec;
}

/**
 * A session is a higher-level abstraction that operates over the span of potentially multiple transport-level connections
 * - It’s responsible for tracking any metadata for a particular client that might need to be persisted across connections (i.e. the sendBuffer, ack, seq)
 * - This will only be considered disconnected if
 *    - the server tells the client that we’ve reconnected but it doesn’t recognize us anymore (server definitely died) or
 *    - we hit a grace period after a connection disconnect
 */
export class Session<ConnType extends Connection> {
  private codec: Codec;
  private options: SessionOptions;
  telemetry: TelemetryInfo;

  /**
   * The buffer of messages that have been sent but not yet acknowledged.
   */
  private sendBuffer: Array<OpaqueTransportMessage> = [];

  /**
   * The active connection associated with this session
   */
  connection?: ConnType;
  readonly from: TransportClientId;
  readonly to: TransportClientId;

  /**
   * The unique ID of this session.
   */
  id: string;

  /**
   * What the other side advertised as their session ID
   * for this session.
   */
  advertisedSessionId?: string;

  /**
   * Number of messages we've sent along this session (excluding handshake and acks)
   */
  private seq: SequenceNumber = 0;

  /**
   * Number of unique messages we've received this session (excluding handshake and acks)
   */
  private ack: SequenceNumber = 0;

  /**
   * The grace period between when the inner connection is disconnected
   * and when we should consider the entire session disconnected.
   */
  private disconnectionGrace?: ReturnType<typeof setTimeout>;

  /**
   * Number of heartbeats we've sent without a response.
   */
  private heartbeatMisses: number;

  /**
   * The interval for sending heartbeats.
   */
  private heartbeat: ReturnType<typeof setInterval>;

  constructor(
    conn: ConnType | undefined,
    from: TransportClientId,
    to: TransportClientId,
    options: SessionOptions,
    propagationCtx?: PropagationContext,
  ) {
    this.id = `session-${nanoid(12)}`;
    this.options = options;
    this.from = from;
    this.to = to;
    this.connection = conn;
    this.codec = options.codec;

    // setup heartbeat
    this.heartbeatMisses = 0;
    this.heartbeat = setInterval(
      () => this.sendHeartbeat(),
      options.heartbeatIntervalMs,
    );
    this.telemetry = createSessionTelemetryInfo(this, propagationCtx);
  }

  get loggingMetadata(): Omit<MessageMetadata, 'parsedMsg'> {
    return {
      clientId: this.from,
      connectedTo: this.to,
      sessionId: this.id,
      connId: this.connection?.id,
    };
  }

  /**
   * Sends a message over the session's connection.
   * If the connection is not ready or the message fails to send, the message can be buffered for retry unless skipped.
   *
   * @param msg The partial message to be sent, which will be constructed into a full message.
   * @param addToSendBuff Whether to add the message to the send buffer for retry.
   * @returns The full transport ID of the message that was attempted to be sent.
   */
  send(msg: PartialTransportMessage): string {
    const fullMsg: TransportMessage = this.constructMsg(msg);
    log?.debug(`sending msg`, {
      ...this.loggingMetadata,
      fullTransportMessage: fullMsg,
    });

    if (this.connection) {
      const ok = this.connection.send(this.codec.toBuffer(fullMsg));
      if (ok) return fullMsg.id;
      log?.info(
        `failed to send msg to ${fullMsg.to}, connection is probably dead`,
        {
          ...this.loggingMetadata,
          fullTransportMessage: fullMsg,
        },
      );
    } else {
      log?.info(
        `failed to send msg to ${fullMsg.to}, connection not ready yet`,
        { ...this.loggingMetadata, fullTransportMessage: fullMsg },
      );
    }

    return fullMsg.id;
  }

  sendHeartbeat() {
    const misses = this.heartbeatMisses;
    const missDuration = misses * this.options.heartbeatIntervalMs;
    if (misses > this.options.heartbeatsUntilDead) {
      if (this.connection) {
        log?.info(
          `closing connection to ${this.to} due to inactivity (missed ${misses} heartbeats which is ${missDuration}ms)`,
          this.loggingMetadata,
        );
        this.telemetry.span.addEvent('closing connection due to inactivity');
        this.closeStaleConnection();
      }
      return;
    }

    this.send({
      streamId: 'heartbeat',
      controlFlags: ControlFlags.AckBit,
      payload: {
        type: 'ACK',
      } satisfies Static<typeof ControlMessageAckSchema>,
    });
    this.heartbeatMisses++;
  }

  resetBufferedMessages() {
    this.sendBuffer = [];
    this.seq = 0;
    this.ack = 0;
  }

  sendBufferedMessages(conn: ConnType) {
    log?.info(`resending ${this.sendBuffer.length} buffered messages`, {
      ...this.loggingMetadata,
      connId: conn.id,
    });
    for (const msg of this.sendBuffer) {
      log?.debug(`resending msg`, {
        ...this.loggingMetadata,
        fullTransportMessage: msg,
        connId: conn.id,
      });
      const ok = conn.send(this.codec.toBuffer(msg));
      if (!ok) {
        // this should never happen unless the transport has an
        // incorrect implementation of `createNewOutgoingConnection`
        const errMsg = `failed to send buffered message to ${this.to} (sus, this is a fresh connection)`;
        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errMsg,
        });

        log?.error(errMsg, {
          ...this.loggingMetadata,
          fullTransportMessage: msg,
          connId: conn.id,
          tags: ['invariant-violation'],
        });
        conn.close();
        return;
      }
    }
  }

  updateBookkeeping(ack: number, seq: number) {
    if (seq + 1 < this.ack) {
      log?.error(`received stale seq ${seq} + 1 < ${this.ack}`, {
        ...this.loggingMetadata,
        tags: ['invariant-violation'],
      });
      return;
    }

    this.sendBuffer = this.sendBuffer.filter((unacked) => unacked.seq >= ack);
    this.ack = seq + 1;
  }

  closeStaleConnection(conn?: ConnType) {
    if (this.connection === undefined || this.connection === conn) return;
    log?.info(
      `closing old inner connection from session to ${this.to}`,
      this.loggingMetadata,
    );
    this.connection.close();
    this.connection = undefined;
  }

  replaceWithNewConnection(newConn: ConnType) {
    this.closeStaleConnection(newConn);
    this.cancelGrace();
    this.connection = newConn;
    this.sendBufferedMessages(newConn);
  }

  beginGrace(cb: () => void) {
    log?.info(
      `starting ${this.options.sessionDisconnectGraceMs}ms grace period until session to ${this.to} is closed`,
      this.loggingMetadata,
    );
    this.disconnectionGrace = setTimeout(() => {
      this.close();
      cb();
    }, this.options.sessionDisconnectGraceMs);
  }

  // called on reconnect of the underlying session
  cancelGrace() {
    this.heartbeatMisses = 0;
    clearTimeout(this.disconnectionGrace);
    this.disconnectionGrace = undefined;
  }

  // closed when we want to discard the whole session
  // (i.e. shutdown or session disconnect)
  close() {
    this.closeStaleConnection();
    this.cancelGrace();
    this.resetBufferedMessages();
    clearInterval(this.heartbeat);
  }

  get connected() {
    return this.connection !== undefined;
  }

  get nextExpectedSeq() {
    return this.ack;
  }

  constructMsg<Payload>(
    partialMsg: PartialTransportMessage<Payload>,
  ): TransportMessage<Payload> {
    const msg = {
      ...partialMsg,
      id: unsafeId(),
      to: this.to,
      from: this.from,
      seq: this.seq,
      ack: this.ack,
    };

    this.seq++;
    this.sendBuffer.push(msg);
    return msg;
  }

  inspectSendBuffer(): ReadonlyArray<OpaqueTransportMessage> {
    return this.sendBuffer;
  }
}
