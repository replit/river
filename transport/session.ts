import { customAlphabet } from 'nanoid';
import {
  MessageId,
  OpaqueTransportMessage,
  TransportClientId,
} from './message';

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvxyz', 4);
const unsafeId = () => nanoid();

/**
 * A 1:1 connection between two transports. Once this is created,
 * the {@link Connection} is expected to take over responsibility for
 * reading and writing messages from the underlying connection.
 */
export abstract class Connection {
  id: string;
  constructor() {
    this.id = `conn-${unsafeId()}`; // for debugging, no collision safety needed
  }

  /**
   * Handle adding a callback for when a message is received.
   * @param msg The message that was received.
   */
  abstract onData(cb: (msg: Uint8Array) => void): void;

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

export const DISCONNECT_GRACE_MS = 3_000; // 3s

/**
 * A session is a collection of stateful information from another peer that outlives a single connection.
 *
 * This includes:
 * 1) A queue of messages that are waiting to be sent over the WebSocket connection.
 *    This builds up if the WebSocket is down for a period of time.
 * 2) A buffer of messages that have been sent but not yet acknowledged.
 * 3) The active connection associated with this session
 *
 * On the server:
 * ```plaintext
 * session         2-----------------------4
 * connection  ----1---------3   1-------3
 *                                       ^-^ grace period
 *             ^---^ connection is created
 *                   before connectionStatus event is fired
 * ```
 *
 * On the client:
 * ```plaintext
 * session     2---------------------------4
 * connection      1---------3   1-------3
 *                                       ^-^ grace period
 *             ^---^ session is created as soon
 *                   as we send an outgoing message
 * ```
 *
 * 1. connectionStatus :: connect
 * 2. sessionStatus    :: connect
 * 3. connectionStatus :: disconnect
 * 4. sessionStatus    :: disconnect
 */
export class Session<ConnType extends Connection> {
  /**
   * An array of message IDs that are waiting to be sent over the connection.
   * This builds up if the there is no connection for a period of time.
   */
  sendQueue: Array<MessageId>;

  /**
   * The buffer of messages that have been sent but not yet acknowledged.
   */
  sendBuffer: Map<MessageId, OpaqueTransportMessage>;

  /**
   * The active connection associated with this session
   */
  connection?: ConnType;

  /**
   * The ID of the client this session is connected to.
   */
  connectedTo: TransportClientId;

  /**
   * The unique ID of this session.
   */
  id: string;

  /**
   * A timeout that is used to close the session if the connection is not re-established
   * within a certain period of time.
   */
  private graceExpiryTimeout?: ReturnType<typeof setTimeout>;

  constructor(connectedTo: TransportClientId, conn: ConnType | undefined) {
    this.id = `sess-${unsafeId()}`; // for debugging, no collision safety needed
    this.sendQueue = [];
    this.sendBuffer = new Map();
    this.connectedTo = connectedTo;
    this.connection = conn;
  }

  resetBufferedMessages() {
    this.sendQueue = [];
    this.sendBuffer.clear();
  }

  beginGrace(cb: () => void) {
    this.graceExpiryTimeout = setTimeout(() => {
      this.resetBufferedMessages();
      cb();
    }, DISCONNECT_GRACE_MS);
  }

  cancelGrace() {
    clearTimeout(this.graceExpiryTimeout);
  }

  get connected() {
    return this.connection !== undefined;
  }
}