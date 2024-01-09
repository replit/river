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
import { EventDispatcher, EventHandler, EventTypes } from './events';

/**
 * A 1:1 connection between two transports. Once this is created,
 * the {@link Connection} is expected to take over responsibility for
 * reading and writing messages from the underlying connection.
 *
 * 1) Messages received on the {@link Connection} are dispatched back to the {@link Transport}
 *    via {@link Transport.onMessage}. The {@link Transport} then notifies any registered message listeners.
 * 2) When {@link Transport.send}(msg) is called, the transport looks up the appropriate
 *    connection in the {@link connections} map via `msg.to` and calls {@link send}(bytes)
 *    so the connection can send it.
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

  abstract send(msg: Uint8Array): boolean;
  abstract close(): void;
}

export type TransportStatus = 'open' | 'closed' | 'destroyed';

/**
 * Transports manage the lifecycle (creation/deletion) of connections. Its responsibilities include:
 * 
 *  1) Constructing a new {@link Connection} on {@link TransportMessage}s from new clients.
 *     After constructing the {@link Connection}, {@link onConnect} is called which adds it to the connection map.
 *  2) Delegating message listening of the connection to the newly created {@link Connection}.
 *     From this point on, the {@link Connection} is responsible for *reading* and *writing*
 *     messages from the connection.
 *  3) When a connection is closed, the {@link Transport} calls {@link onDisconnect} which closes the
 *     connection via {@link Connection.close} and removes it from the {@link connections} map.

 *
 * ```plaintext
 *            ▲
 *  incoming  │
 *  messages  │
 *            ▼
 *      ┌─────────────┐   1:N   ┌────────────┐
 *      │  Transport  │ ◄─────► │ Connection │
 *      └─────────────┘         └────────────┘
 *            ▲
 *            │
 *            ▼
 *      ┌───────────┐
 *      │ Message   │
 *      │ Listeners │
 *      └───────────┘
 * ```
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
   * The event dispatcher for handling events of type EventTypes.
   */
  eventDispatcher: EventDispatcher<EventTypes>;

  /**
   * Creates a new Transport instance.
   * This should also set up {@link onConnect}, and {@link onDisconnect} listeners.
   * @param codec The codec used to encode and decode messages.
   * @param clientId The client ID of this transport.
   */
  constructor(codec: Codec, clientId: TransportClientId) {
    this.eventDispatcher = new EventDispatcher();
    this.sendBuffer = new Map();
    this.sendQueue = new Map();
    this.connections = new Map();
    this.codec = codec;
    this.clientId = clientId;
    this.state = 'open';
  }

  /**
   * Abstract method that creates a new {@link Connection} object.
   * This should call {@link onConnect} when the connection is established.
   * The downstream implementation needs to implement this. If the downstream
   * transport cannot make new outgoing connections (e.g. a server transport),
   * it is ok to log an error and return.
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

    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'connect',
      conn,
    });

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

    this.sendQueue.delete(conn.connectedTo);
  }

  /**
   * The downstream implementation needs to call this when a connection is closed.
   * @param conn The connection object.
   */
  onDisconnect(conn: ConnType) {
    log?.info(`${this.clientId} -- disconnect from ${conn.connectedTo}`);
    conn.close();
    this.connections.delete(conn.connectedTo);
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'disconnect',
      conn,
    });
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
      // JSON can't express the difference between `undefined` and `null`, so we need to patch that.
      return {
        ...parsedMsg,
        serviceName:
          parsedMsg.serviceName === null ? undefined : parsedMsg.serviceName,
        procedureName:
          parsedMsg.procedureName === null
            ? undefined
            : parsedMsg.procedureName,
      };
    } else {
      log?.warn(
        `${this.clientId} -- received invalid msg: ${JSON.stringify(
          parsedMsg,
        )}`,
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
      log?.debug(`${this.clientId} -- received ack: ${JSON.stringify(msg)}`);
      if (this.sendBuffer.has(msg.payload.ack)) {
        this.sendBuffer.delete(msg.payload.ack);
      }
    } else {
      // regular river message
      log?.debug(`${this.clientId} -- received msg: ${JSON.stringify(msg)}`);
      this.eventDispatcher.dispatchEvent('message', msg);

      if (!isAck(msg.controlFlags)) {
        const ackMsg = reply(msg, { ack: msg.id });
        ackMsg.controlFlags = ControlFlags.AckBit;
        ackMsg.from = this.clientId;

        this.send(ackMsg);
      }
    }
  }

  /**
   * Adds a listener to this transport.
   * @param the type of event to listen for
   * @param handler The message handler to add.
   */
  addEventListener<K extends EventTypes, T extends EventHandler<K>>(
    type: K,
    handler: T,
  ): void {
    this.eventDispatcher.addEventListener(type, handler);
  }

  /**
   * Removes a listener from this transport.
   * @param the type of event to unlisten on
   * @param handler The message handler to remove.
   */
  removeEventListener<K extends EventTypes, T extends EventHandler<K>>(
    type: K,
    handler: T,
  ): void {
    this.eventDispatcher.removeEventListener(type, handler);
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
      log?.debug(`${this.clientId} -- sending ${JSON.stringify(msg)}`);
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
