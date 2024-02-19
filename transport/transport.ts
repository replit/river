import { Codec } from '../codec/types';
import { Value } from '@sinclair/typebox/value';
import {
  ControlFlags,
  OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
  TransportAckSchema,
  TransportClientId,
  isAck,
  reply,
} from './message';
import { log } from '../logging';
import { EventDispatcher, EventHandler, EventTypes } from './events';
import { Connection, DISCONNECT_GRACE_MS, Session } from './session';

export type TransportStatus = 'open' | 'closed' | 'destroyed';

/**
 * Transports manage the lifecycle (creation/deletion) of sessions and connections. Its responsibilities include:
 * 
 *  1) Constructing a new {@link Session} and {@link Connection} on {@link TransportMessage}s from new clients.
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
 *      ┌─────────────┐   1:N   ┌───────────┐   1:1*  ┌────────────┐
 *      │  Transport  │ ◄─────► │  Session  │ ◄─────► │ Connection │
 *      └─────────────┘         └───────────┘         └────────────┘
 *            ▲                               * (may or may not be initialized yet)
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
   * The map of {@link Session}s managed by this transport.
   */
  sessions: Map<TransportClientId, Session<ConnType>>;

  get connections() {
    return new Map(
      [...this.sessions]
        .map(([client, session]) => [client, session.connection])
        .filter((entry): entry is [string, ConnType] => entry[1] !== undefined),
    );
  }

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
    this.sessions = new Map();
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
   *
   * Consumers of river should never need to call this directly.
   * Instead, look for a `reopen` method on the transport.
   *
   * @param to The client ID of the node to connect to.
   * @returns The new connection object.
   */
  abstract createNewConnection(to: TransportClientId): Promise<void>;

  private sessionByClientId(clientId: TransportClientId): Session<ConnType> {
    const session = this.sessions.get(clientId);
    if (!session) {
      const err = `${this.clientId} -- (invariant violation) no existing session for ${clientId}`;
      log?.error(err);
      throw new Error(err);
    }

    return session;
  }

  private closeStaleConnectionForSession(
    conn: ConnType,
    session: Session<ConnType>,
  ) {
    // only close the connection if the stale one is the one we have a handle to
    if (!session.connection || session.connection.id !== conn.id) return;
    session.connection?.close();
    session.connection = undefined;
    log?.info(
      `${this.clientId} -- closing old inner connection (id: ${conn.id}) from session (id: ${session.id}) to ${session.connectedTo}`,
    );
  }

  /**
   * The downstream implementation needs to call this when a new connection is established
   * and we know the identity of the connected client.
   * @param conn The connection object.
   */
  onConnect(conn: ConnType, connectedTo: TransportClientId): Session<ConnType> {
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'connect',
      conn,
    });

    log?.info(
      `${this.clientId} -- new connection (id: ${conn.id}) to ${connectedTo}`,
    );
    const session = this.sessions.get(connectedTo);
    if (session === undefined) {
      // new session, create and return
      return this.createSession(connectedTo, conn);
    }

    // otherwise, this is a duplicate session from the same user, let's consider
    // the old one as dead and call this one canonical
    this.closeStaleConnectionForSession(conn, session);
    session.connection = conn;
    session.cancelGrace();

    // if there are any unacked messages in the sendQueue, send them now
    for (const id of session.sendQueue) {
      const msg = session.sendBuffer.get(id);
      if (msg) {
        const ok = this.send(msg);
        if (!ok) {
          // this should never happen unless the transport has an
          // incorrect implementation of `createNewConnection`
          const msg = `${this.clientId} -- failed to send queued message to ${connectedTo} in session (id: ${session.id}) (if you hit this code path something is seriously wrong)`;
          log?.error(msg);
          throw new Error(msg);
        }
      }
    }

    session.sendQueue = [];
    return session;
  }

  private createSession(
    connectedTo: TransportClientId,
    conn: ConnType | undefined,
  ) {
    const session = new Session<ConnType>(connectedTo, conn);
    log?.info(
      `${this.clientId} -- new session (id: ${session.id}) to ${connectedTo}`,
    );
    this.sessions.set(session.connectedTo, session);
    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'connect',
      session,
    });
    return session;
  }

  /**
   * The downstream implementation needs to call this when a connection is closed.
   * @param conn The connection object.
   */
  onDisconnect(conn: ConnType, connectedTo: TransportClientId | undefined) {
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'disconnect',
      conn,
    });

    // if connectedTo is not set, we've disconnect before the first message is received
    // therefore there is no associated session
    if (connectedTo) {
      const session = this.sessionByClientId(connectedTo);
      log?.info(
        `${this.clientId} -- connection (id: ${conn.id}) disconnect from ${connectedTo}, ${DISCONNECT_GRACE_MS}ms until session (id: ${session.id}) disconnect`,
      );

      this.closeStaleConnectionForSession(conn, session);
      session.beginGrace(() => {
        log?.info(
          `${this.clientId} -- session ${session.id} disconnect from ${connectedTo}`,
        );
        this.sessions.delete(session.connectedTo);
        this.eventDispatcher.dispatchEvent('sessionStatus', {
          status: 'disconnect',
          session,
        });
      });
    }
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

    if (!Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
      log?.warn(
        `${this.clientId} -- received invalid msg: ${JSON.stringify(
          parsedMsg,
        )}`,
      );
      return null;
    }

    // JSON can't express the difference between `undefined` and `null`, so we need to patch that.
    return {
      ...parsedMsg,
      serviceName:
        parsedMsg.serviceName === null ? undefined : parsedMsg.serviceName,
      procedureName:
        parsedMsg.procedureName === null ? undefined : parsedMsg.procedureName,
    };
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

    // got a msg so we know the other end is alive, reset the grace period
    const session = this.sessionByClientId(msg.from);
    session.cancelGrace();

    if (isAck(msg.controlFlags) && Value.Check(TransportAckSchema, msg)) {
      // process ack
      log?.debug(`${this.clientId} -- received ack: ${JSON.stringify(msg)}`);
      if (session.sendBuffer.has(msg.payload.ack)) {
        session.sendBuffer.delete(msg.payload.ack);
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
  send(msg: OpaqueTransportMessage): boolean {
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
      return false;
    }

    let session = this.sessions.get(msg.to);
    if (!session) {
      log?.info(
        `${this.clientId} -- no session for ${msg.to}, creating a new one`,
      );
      session = this.createSession(msg.to, undefined);
    }

    let conn = session?.connection;

    // we only use sendBuffer to track messages that we expect an ack from,
    // messages with the ack flag are not responded to
    if (!isAck(msg.controlFlags)) {
      session.sendBuffer.set(msg.id, msg);
    }

    if (conn) {
      log?.debug(`${this.clientId} -- sending ${JSON.stringify(msg)}`);
      const ok = conn.send(this.codec.toBuffer(msg));
      if (ok) return true;
      log?.info(
        `${this.clientId} -- connection (id: ${conn.id}) to ${msg.to} probably died, attempting to reconnect and queuing msg ${msg.id}`,
      );
    } else {
      log?.info(
        `${this.clientId} -- connection to ${msg.to} doesn't exist, attempting to connect and queuing msg ${msg.id}`,
      );
    }

    session.sendQueue.push(msg.id);
    log?.debug(
      `${this.clientId} -- now at ${session.sendQueue.length} outstanding messages to ${msg.to}`,
    );
    this.createNewConnection(msg.to);
    return false;
  }

  /**
   * Default close implementation for transports. You should override this in the downstream
   * implementation if you need to do any additional cleanup and call super.close() at the end.
   * Closes the transport. Any messages sent while the transport is closed will be silently discarded.
   */
  async close() {
    for (const session of this.sessions.values()) {
      session.connection?.close();
      session.connection = undefined;
    }

    this.state = 'closed';
    log?.info(`${this.clientId} -- manually closed transport`);
  }

  /**
   * Default destroy implementation for transports. You should override this in the downstream
   * implementation if you need to do any additional cleanup and call super.destroy() at the end.
   * Destroys the transport. Any messages sent while the transport is destroyed will throw an error.
   */
  async destroy() {
    for (const session of this.sessions.values()) {
      session.connection?.close();
      session.connection = undefined;
    }

    this.state = 'destroyed';
    log?.info(`${this.clientId} -- manually destroyed transport`);
  }
}
