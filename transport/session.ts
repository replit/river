import { customAlphabet } from 'nanoid';
import {
  MessageId,
  OpaqueTransportMessage,
  TransportClientId,
} from './message';

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvxyz', 4);
const unsafeId = () => nanoid();

/**
 * A connection is the actual raw underlying transport connection.
 * It’s responsible for dispatching to/from the actual connection itself
 * This should be instantiated as soon as the client/server has a connection
 * It’s tied to the lifecycle of the underlying transport connection (i.e. if the WS drops, this connection should be deleted)
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
 * A session is a higher-level abstraction that operates over the span of potentially multiple transport-level connections
 * - It’s responsible for tracking any metadata for a particular client that might need to be persisted across connections (i.e. the sendBuffer and sendQueue)
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
