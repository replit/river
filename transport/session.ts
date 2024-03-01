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
import { log } from '../logging';
import { Static } from '@sinclair/typebox';

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
  debugId: string;
  constructor() {
    this.debugId = `conn-${unsafeId()}`; // for debugging, no collision safety needed
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

export const HEARTBEAT_INTERVAL_MS = 1000; // 1s
export const HEARTBEATS_TILL_DEAD = 2; // can miss max of 2 heartbeats before we consider the connection dead
export const SESSION_DISCONNECT_GRACE_MS = 5_000; // 5s

/**
 * A session is a higher-level abstraction that operates over the span of potentially multiple transport-level connections
 * - It’s responsible for tracking any metadata for a particular client that might need to be persisted across connections (i.e. the sendBuffer, ack, seq)
 * - This will only be considered disconnected if
 *    - the server tells the client that we’ve reconnected but it doesn’t recognize us anymore (server definitely died) or
 *    - we hit a grace period after a connection disconnect
 *
 * Here's a legend for what each of the numbers means. A '-' indicates the
 * session/connection is connected and ' ' means it is disconnected.
 *
 * 1. connectionStatus :: connect
 * 2. sessionStatus    :: connect
 * 3. connectionStatus :: disconnect
 * 4. sessionStatus    :: disconnect
 *
 * From the server's perspective:
 * ```plaintext
 * session         2-----------------------4
 * connection  ----1---------3   1-------3
 *                                       ^-^ grace period
 *             ^---^ connection is created
 *                   before connectionStatus event is fired
 * ```
 *
 * From the client's perspective:
 * ```plaintext
 * session     2---------------------------4
 * connection      1---------3   1-------3
 *                                       ^-^ grace period
 *             ^---^ session is created as soon
 *                   as we send an outgoing message
 * ```
 */
export class Session<ConnType extends Connection> {
  private codec: Codec;

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
  debugId: string;

  /**
   * Number of messages we've sent along this session (excluding handshake)
   */
  private seq: SequenceNumber = 0;

  /**
   * Number of unique messages we've received this session (excluding handshake)
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
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(
    codec: Codec,
    from: TransportClientId,
    connectedTo: TransportClientId,
    conn: ConnType | undefined,
  ) {
    this.debugId = `sess-${unsafeId()}`; // for debugging, no collision safety needed
    this.from = from;
    this.to = connectedTo;
    this.connection = conn;
    this.codec = codec;

    // setup heartbeat
    this.heartbeatMisses = 0;
    this.heartbeat = setInterval(
      () => this.sendHeartbeat(),
      HEARTBEAT_INTERVAL_MS,
    );
  }

  /**
   * Sends a message over the session's connection.
   * If the connection is not ready or the message fails to send, the message can be buffered for retry unless skipped.
   *
   * @param msg The partial message to be sent, which will be constructed into a full message.
   * @param skipRetry Optional. If true, the message will not be buffered for retry on failure. This should only be used for
   * ack hearbeats, which contain information that can already be found in the other buffered messages.
   * @returns The full transport ID of the message that was attempted to be sent.
   */
  send(msg: PartialTransportMessage, skipRetry?: boolean): string {
    const fullMsg: TransportMessage = this.constructMsg(msg);
    log?.debug(`${this.from} -- sending ${JSON.stringify(fullMsg)}`);

    if (this.connection) {
      const ok = this.connection.send(this.codec.toBuffer(fullMsg));
      if (ok) return fullMsg.id;
      log?.info(
        `${this.from} -- failed to send ${fullMsg.id} to ${fullMsg.to}, connection (id: ${this.connection.debugId}) is probably dead`,
      );
    } else {
      log?.info(
        `${this.from} -- failed to send ${fullMsg.id} to ${fullMsg.to}, connection not ready yet`,
      );
    }

    if (skipRetry) return fullMsg.id;
    this.addToSendBuff(fullMsg);
    log?.info(
      `${this.from} -- buffering msg ${fullMsg.id} until connection is healthy again`,
    );
    return fullMsg.id;
  }

  sendHeartbeat() {
    if (this.heartbeatMisses >= HEARTBEATS_TILL_DEAD) {
      if (this.connection) {
        log?.info(
          `${this.from} -- closing connection (id: ${this.connection.debugId}) to ${this.to} due to inactivity`,
        );
        this.closeStaleConnection(this.connection);
      }
      return;
    }

    this.send(
      {
        streamId: 'heartbeat',
        controlFlags: ControlFlags.AckBit,
        payload: {
          type: 'ACK',
        } satisfies Static<typeof ControlMessageAckSchema>,
      },
      true,
    );
    this.heartbeatMisses++;
  }

  resetBufferedMessages() {
    this.sendBuffer = [];
    this.seq = 0;
    this.ack = 0;
  }

  sendBufferedMessages() {
    if (!this.connection) {
      const msg = `${this.from} -- tried sending buffered messages without a connection (if you hit this code path something is seriously wrong)`;
      log?.error(msg);
      throw new Error(msg);
    }

    for (const msg of this.sendBuffer) {
      log?.debug(`${this.from} -- resending ${JSON.stringify(msg)}`);
      const ok = this.connection.send(this.codec.toBuffer(msg));
      if (!ok) {
        // this should never happen unless the transport has an
        // incorrect implementation of `createNewOutgoingConnection`
        const msg = `${this.from} -- failed to send buffered message to ${this.to} in session (id: ${this.debugId}) (if you hit this code path something is seriously wrong)`;
        log?.error(msg);
        throw new Error(msg);
      }
    }
  }

  updateBookkeeping(ack: number, seq: number) {
    this.sendBuffer = this.sendBuffer.filter((unacked) => unacked.seq > ack);
    this.ack = seq + 1;
  }

  addToSendBuff(msg: TransportMessage) {
    this.sendBuffer.push(msg);
    log?.debug(
      `${this.from} -- send buff to ${this.to} now tracking ${this.sendBuffer.length} messages`,
    );
  }

  closeStaleConnection(conn?: ConnType) {
    if (!this.connection || this.connection !== conn) return;
    log?.info(
      `${this.from} -- closing old inner connection (id: ${this.connection.debugId}) from session (id: ${this.debugId}) to ${this.to}`,
    );
    this.connection.close();
    this.connection = undefined;
  }

  replaceWithNewConnection(newConn: ConnType) {
    this.closeStaleConnection(this.connection);
    this.cancelGrace();
    this.connection = newConn;
  }

  graceCb?: () => unknown;
  beginGrace(cb: () => void) {
    this.graceCb = cb;
    this.disconnectionGrace = setTimeout(() => {
      this.close();
      cb();
    }, SESSION_DISCONNECT_GRACE_MS);
  }

  // called on reconnect of the underlying session
  cancelGrace() {
    this.heartbeatMisses = 0;
    clearTimeout(this.disconnectionGrace);
  }

  // closed when we want to discard the whole session
  // (i.e. shutdown or session disconnect)
  close() {
    this.closeStaleConnection(this.connection);
    this.cancelGrace();
    clearInterval(this.heartbeat);
    this.resetBufferedMessages();
  }

  get connected() {
    return this.connection !== undefined;
  }

  get nextExpectedSeq() {
    return this.ack;
  }

  constructMsg<Payload extends Record<string, unknown>>(
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
    return msg;
  }

  inspectSendBuffer(): ReadonlyArray<OpaqueTransportMessage> {
    return this.sendBuffer;
  }
}
