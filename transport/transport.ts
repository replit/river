import { Codec } from '../codec/types';
import { Value } from '@sinclair/typebox/value';
import {
  ControlFlags,
  MessageId,
  OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
  TransportAckSchema,
  TransportClientId,
  isAck,
  reply,
} from './message';
import { log } from '../logging';

/**
 * Abstract base for a connection between two nodes in a River network.
 * A connection is responsible for sending and receiving messages on a 1:1
 * basis between nodes.
 * Connections can be reused across different transports.
 * @abstract
 */
export abstract class Connection {
  connectedTo: TransportClientId;
  transport: Transport<Connection>;

  constructor(
    transport: Transport<Connection>,
    connectedTo: TransportClientId,
  ) {
    this.connectedTo = connectedTo;
    this.transport = transport;
  }

  onMessage(msg: Uint8Array) {
    return this.transport.onMessage(msg);
  }

  abstract send(msg: Uint8Array): boolean;
  abstract close(): Promise<void>;
}

export type TransportStatus = 'open' | 'closed' | 'destroyed';

/**
 * Abstract base for a transport layer for communication between nodes in a River network.
 * A transport is responsible for handling the 1:n connection logic between nodes and
 * delegating sending/receiving to connections.
 * Any River transport methods need to implement this interface.
 * @abstract
 */
export abstract class Transport<ConnType extends Connection> {
  /**
   * A flag indicating whether the transport has been destroyed.
   * A destroyed transport will not attempt to reconnect and cannot be used again.
   */
  state: TransportStatus;

  /**
   * The {@link Codec} used to encode and decode messages.
   */
  codec: Codec;

  /**
   * The client ID of this transport.
   */
  clientId: TransportClientId;

  /**
   * The set of message handlers registered with this transport.
   */
  messageHandlers: Set<(msg: OpaqueTransportMessage) => void>;

  /**
   * An array of message IDs that are waiting to be sent over the WebSocket connection.
   * This builds up if the WebSocket is down for a period of time.
   */
  sendQueue: Map<TransportClientId, Array<MessageId>>;

  /**
   * The buffer of messages that have been sent but not yet acknowledged.
   */
  sendBuffer: Map<MessageId, OpaqueTransportMessage>;

  /**
   * The map of {@link Connection}s managed by this transport.
   */
  connections: Map<TransportClientId, ConnType>;

  /**
   * Creates a new Transport instance.
   * @param codec The codec used to encode and decode messages.
   * @param clientId The client ID of this transport.
   */
  constructor(codec: Codec, clientId: TransportClientId) {
    this.messageHandlers = new Set();
    this.sendBuffer = new Map();
    this.sendQueue = new Map();
    this.connections = new Map();
    this.codec = codec;
    this.clientId = clientId;
    this.state = 'open';
  }

  /**
   * Abstract method that sets up {@link onConnect}, and {@link onDisconnect} listeners.
   * The downstream implementation needs to implement this.
   */
  abstract setupConnectionStatusListeners(): void;

  /**
   * Abstract method that creates a new {@link Connection} object. This should call
   * {@link onConnect} when the connection is established. The downstream implementation needs to implement this.
   * @param to The client ID of the node to connect to.
   * @returns The new connection object.
   */
  abstract createNewConnection(to: TransportClientId): Promise<void>;

  /**
   * The downstream implementation needs to call this when a new connection is established.
   * @param conn The connection object.
   */
  onConnect(conn: ConnType) {
    log?.info(`${this.clientId} -- new connection to ${conn.connectedTo}`);
    this.connections.set(conn.connectedTo, conn);

    // send outstanding
    const outstanding = this.sendQueue.get(conn.connectedTo);
    if (!outstanding) {
      return;
    }

    for (const id of outstanding) {
      const msg = this.sendBuffer.get(id);
      if (!msg) {
        log?.warn(
          `${this.clientId} -- tried to resend a message we received an ack for`,
        );
        continue;
      }

      this.send(msg);
    }

    this.sendQueue.set(conn.connectedTo, []);
  }

  /**
   * The downstream implementation needs to call this when a connection is closed.
   * @param conn The connection object.
   */
  onDisconnect(conn: ConnType) {
    log?.info(`${this.clientId} -- disconnect from ${conn.connectedTo}`);
    conn.close();
    this.connections.delete(conn.connectedTo);
  }

  /**
   * Handles a message received by this transport. Thin wrapper around {@link handleMsg} and {@link parseMsg}.
   * @param msg The message to handle.
   */
  onMessage(msg: Uint8Array) {
    return this.handleMsg(this.parseMsg(msg));
  }

  /**
   * Parses a message from a Uint8Array into a {@link OpaqueTransportMessage}.
   * @param msg The message to parse.
   * @returns The parsed message, or null if the message is malformed or invalid.
   */
  protected parseMsg(msg: Uint8Array): OpaqueTransportMessage | null {
    const parsedMsg = this.codec.fromBuffer(msg);

    if (parsedMsg === null) {
      const decodedBuffer = new TextDecoder().decode(msg);
      log?.warn(`${this.clientId} -- received malformed msg: ${decodedBuffer}`);
      return null;
    }

    if (Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
      return parsedMsg;
    } else {
      log?.warn(
        `${this.clientId} -- received invalid msg: ${JSON.stringify(msg)}`,
      );
      return null;
    }
  }

  /**
   * Called when a message is received by this transport.
   * You generally shouldn't need to override this in downstream transport implementations.
   * @param msg The received message.
   */
  protected handleMsg(msg: OpaqueTransportMessage | null) {
    if (!msg) {
      return;
    }

    if (isAck(msg.controlFlags) && Value.Check(TransportAckSchema, msg)) {
      // process ack
      log?.info(`${this.clientId} -- received ack: ${JSON.stringify(msg)}`);
      if (this.sendBuffer.has(msg.payload.ack)) {
        this.sendBuffer.delete(msg.payload.ack);
      }
    } else {
      // regular river message
      log?.info(`${this.clientId} -- received msg: ${JSON.stringify(msg)}`);
      if (msg.to !== this.clientId) {
        return;
      }

      for (const handler of this.messageHandlers) {
        handler(msg);
      }

      if (!isAck(msg.controlFlags)) {
        const ackMsg = reply(msg, { ack: msg.id });
        ackMsg.controlFlags = ControlFlags.AckBit;
        ackMsg.from = this.clientId;

        this.send(ackMsg);
      }
    }
  }

  /**
   * Adds a message listener to this transport.
   * @param handler The message handler to add.
   */
  addMessageListener(handler: (msg: OpaqueTransportMessage) => void): void {
    this.messageHandlers.add(handler);
  }

  /**
   * Removes a message listener from this transport.
   * @param handler The message handler to remove.
   */
  removeMessageListener(handler: (msg: OpaqueTransportMessage) => void): void {
    this.messageHandlers.delete(handler);
  }

  /**
   * Sends a message over this transport, delegating to the appropriate connection to actually
   * send the message.
   * @param msg The message to send.
   * @returns The ID of the sent message.
   */
  send(msg: OpaqueTransportMessage): MessageId {
    if (this.state === 'destroyed') {
      const err = 'transport is destroyed, cant send';
      log?.error(`${this.clientId} -- ` + err + `: ${JSON.stringify(msg)}`);
      throw new Error(err);
    } else if (this.state === 'closed') {
      log?.info(
        `${
          this.clientId
        } -- transport closed when sending, discarding : ${JSON.stringify(
          msg,
        )}`,
      );
      return msg.id;
    }

    let conn = this.connections.get(msg.to);

    // we only use sendBuffer to track messages that we expect an ack from,
    // messages with the ack flag are not responded to
    if (!isAck(msg.controlFlags)) {
      this.sendBuffer.set(msg.id, msg);
    }

    if (conn) {
      log?.info(`${this.clientId} -- sending ${JSON.stringify(msg)}`);
      const ok = conn.send(this.codec.toBuffer(msg));
      if (ok) {
        return msg.id;
      }
    }

    log?.info(
      `${this.clientId} -- connection to ${
        msg.to
      } not ready, attempting reconnect and queuing ${JSON.stringify(msg)}`,
    );
    const outstanding = this.sendQueue.get(msg.to) || [];
    outstanding.push(msg.id);
    this.sendQueue.set(msg.to, outstanding);
    this.createNewConnection(msg.to);
    return msg.id;
  }

  /**
   * Default close implementation for transports. You should override this in the downstream
   * implementation if you need to do any additional cleanup and call super.close() at the end.
   * Closes the transport. Any messages sent while the transport is closed will be silently discarded.
   */
  async close() {
    for (const conn of this.connections.values()) {
      conn.close();
    }

    this.connections.clear();
    this.state = 'closed';
    log?.info(`${this.clientId} -- closed transport`);
  }

  /**
   * Default destroy implementation for transports. You should override this in the downstream
   * implementation if you need to do any additional cleanup and call super.destroy() at the end.
   * Destroys the transport. Any messages sent while the transport is destroyed will throw an error.
   */
  async destroy() {
    for (const conn of this.connections.values()) {
      conn.close();
    }

    this.connections.clear();
    this.state = 'destroyed';
    log?.info(`${this.clientId} -- destroyed transport`);
  }
}
