import { Codec } from '../codec/types';
import { Value } from '@sinclair/typebox/value';
import {
  OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
  TransportClientId,
  ControlMessageHandshakeRequestSchema,
  ControlMessageHandshakeResponseSchema,
  bootRequestMessage,
  bootResponseMessage,
  PartialTransportMessage,
  TransportMessage,
  ControlFlags,
  ControlMessagePayloadSchema,
} from './message';
import { log } from '../logging';
import { EventDispatcher, EventHandler, EventTypes } from './events';
import { Connection, DISCONNECT_GRACE_MS, Session } from './session';
import { NaiveJsonCodec } from '../codec';
import { Static } from '@sinclair/typebox';

/**
 * Represents the possible states of a transport.
 * @property {'open'} open - The transport is open and operational (note that this doesn't mean it is actively connected)
 * @property {'closed'} closed - The transport is closed and not operational, but can be reopened.
 * @property {'destroyed'} destroyed - The transport is permanently destroyed and cannot be reopened.
 */
export type TransportStatus = 'open' | 'closed' | 'destroyed';

export interface TransportOptions {
  retryIntervalMs: number;
  retryJitterMs: number;
  retryAttemptsMax: number;
  codec: Codec;
}

/**
 * The default maximum jitter for exponential backoff.
 */
export const DEFAULT_WS_JITTER_MAX_MS = 500;

/**
 * The default retry interval for reconnecting to a transport.
 * The actual interval is an exponent backoff calculated as follows:
 * ms = retryIntervalMs * (2 ** attempt) + jitter
 */
export const DEFAULT_WS_RETRY_INTERVAL_MS = 250;
export const defaultTransportOptions: TransportOptions = {
  retryIntervalMs: DEFAULT_WS_RETRY_INTERVAL_MS,
  retryJitterMs: DEFAULT_WS_JITTER_MAX_MS,
  retryAttemptsMax: 5,
  codec: NaiveJsonCodec,
};

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

  /**
   * The map of {@link Connection}s managed by this transport.
   */
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
   * The options for this transport.
   */
  options: TransportOptions;

  /**
   * Creates a new Transport instance.
   * This should also set up {@link onConnect}, and {@link onDisconnect} listeners.
   * @param codec The codec used to encode and decode messages.
   * @param clientId The client ID of this transport.
   */
  constructor(
    clientId: TransportClientId,
    providedOptions?: Partial<TransportOptions>,
  ) {
    this.options = { ...defaultTransportOptions, ...providedOptions };
    this.eventDispatcher = new EventDispatcher();
    this.sessions = new Map();
    this.codec = this.options.codec;
    this.clientId = clientId;
    this.state = 'open';
  }

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
    if (!session.connection || session.connection.debugId !== conn.debugId)
      return;
    session.connection?.close();
    session.connection = undefined;
    log?.info(
      `${this.clientId} -- closing old inner connection (id: ${conn.debugId}) from session (id: ${session.debugId}) to ${session.to}`,
    );
  }

  /**
   * This is called immediately after a new connection is established and we
   * may or may not know the identity of the connected client.
   * It should attach all the necessary listeners to the connection for lifecycle
   * events (i.e. data, close, error)
   *
   * This method is implemented by {@link ClientTransport} and {@link ServerTransport}.
   */
  protected abstract handleConnection(
    conn: ConnType,
    to: TransportClientId,
  ): void;

  /**
   * Called when a new connection is established
   * and we know the identity of the connected client.
   * @param conn The connection object.
   */
  protected onConnect(
    conn: ConnType,
    connectedTo: TransportClientId,
  ): Session<ConnType> {
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'connect',
      conn,
    });

    const session = this.sessions.get(connectedTo);
    if (session === undefined) {
      // new session, create and return
      const newSession = this.createSession(connectedTo, conn);
      log?.info(
        `${this.clientId} -- new connection (id: ${conn.debugId}) for new session (id: ${newSession.debugId}) to ${connectedTo}`,
      );
      return newSession;
    }

    log?.info(
      `${this.clientId} -- new connection (id: ${conn.debugId}) for existing session (id: ${session.debugId}) to ${connectedTo}`,
    );

    // otherwise, this is a duplicate session from the same user, let's consider
    // the old one as dead and call this one canonical
    this.closeStaleConnectionForSession(conn, session);
    session.connection = conn;
    session.cancelGrace();

    // if there are any unacked messages in the sendQueue, send them now
    // for (const id of session.sendQueue) {
    //   const msg = session.sendBuffer.get(id);
    //   if (msg) {
    //     const ok = this.send(msg);
    //     if (!ok) {
    //       // this should never happen unless the transport has an
    //       // incorrect implementation of `createNewOutgoingConnection`
    //       const msg = `${this.clientId} -- failed to send queued message to ${connectedTo} in session (id: ${session.debugId}) (if you hit this code path something is seriously wrong)`;
    //       log?.error(msg);
    //       throw new Error(msg);
    //     }
    //   }
    // }
    //
    // session.sendQueue = [];
    // TODO: refactor these
    return session;
  }

  private createSession(
    connectedTo: TransportClientId,
    conn: ConnType | undefined,
  ) {
    const session = new Session<ConnType>(this.clientId, connectedTo, conn);
    this.sessions.set(session.to, session);
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
    if (!connectedTo) return;
    const session = this.sessionByClientId(connectedTo);
    log?.info(
      `${this.clientId} -- connection (id: ${conn.debugId}) disconnect from ${connectedTo}, ${DISCONNECT_GRACE_MS}ms until session (id: ${session.debugId}) disconnect`,
    );

    this.closeStaleConnectionForSession(conn, session);
    session.beginGrace(() => {
      this.sessions.delete(session.to);
      this.eventDispatcher.dispatchEvent('sessionStatus', {
        status: 'disconnect',
        session,
      });
      log?.info(
        `${this.clientId} -- session ${session.debugId} disconnect from ${connectedTo}`,
      );
    });
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
  handleMsg(msg: OpaqueTransportMessage | null) {
    if (!msg) {
      return;
    }

    // got a msg so we know the other end is alive, reset the grace period
    const session = this.sessionByClientId(msg.from);
    session.cancelGrace();

    log?.debug(`${this.clientId} -- received msg: ${JSON.stringify(msg)}`);
    if (msg.seq !== session.ack + 1) {
      log?.warn(
        `${
          this.clientId
        } -- received out-of-order msg, discarding: ${JSON.stringify(msg)}`,
      );
      return;
    }

    session.sendBuffer = session.sendBuffer.filter(
      (unacked) => unacked.seq < msg.ack,
    );
    this.eventDispatcher.dispatchEvent('message', msg);
    session.ack = msg.seq;
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
   * @returns The ID of the sent message or undefined if it wasn't sent
   */
  send(
    to: TransportClientId,
    msg: PartialTransportMessage,
  ): string | undefined {
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
      return undefined;
    }

    let session = this.sessions.get(to);
    if (!session) {
      // this case happens on the client as .send()
      // can be called without a session existing so we
      // must create the session here
      session = this.createSession(to, undefined);
      log?.info(
        `${this.clientId} -- no session for ${to}, created a new one (id: ${session.debugId})`,
      );
    }

    let conn = session?.connection;
    const fullMsg: TransportMessage = session.constructMsg(msg);
    if (conn) {
      log?.debug(`${this.clientId} -- sending ${JSON.stringify(msg)}`);
      const ok = this.rawSend(conn, fullMsg);
      if (ok) return fullMsg.id;
      log?.info(
        `${this.clientId} -- failed to send on connection (id: ${conn.debugId}) to ${fullMsg.to}, queuing msg ${fullMsg.id}`,
      );
    } else {
      log?.info(
        `${this.clientId} -- connection to ${to} doesn't exist, queuing msg ${fullMsg.id}`,
      );
    }

    session.sendBuffer.push(fullMsg);
    log?.debug(
      `${this.clientId} -- now at ${session.sendBuffer.length} outstanding messages to ${to}`,
    );
    return undefined;
  }

  // control helpers
  sendCloseStream(to: TransportClientId, streamId: string) {
    return this.send(to, {
      streamId: streamId,
      controlFlags: ControlFlags.StreamClosedBit,
      payload: {
        type: 'CLOSE' as const,
      } satisfies Static<typeof ControlMessagePayloadSchema>,
    });
  }

  protected rawSend(conn: ConnType, msg: OpaqueTransportMessage): boolean {
    log?.debug(`${this.clientId} -- sending ${JSON.stringify(msg)}`);
    const ok = conn.send(this.codec.toBuffer(msg));
    if (ok) return true;
    log?.info(
      `${this.clientId} -- failed to send on connection (id: ${conn.debugId}) to ${msg.to}, queuing msg ${msg.id}`,
    );
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
    }

    this.state = 'destroyed';
    log?.info(`${this.clientId} -- manually destroyed transport`);
  }
}

export abstract class ClientTransport<
  ConnType extends Connection,
> extends Transport<ConnType> {
  /**
   * The map of reconnect promises for each client ID.
   */
  inflightConnectionPromises: Map<TransportClientId, Promise<ConnType>>;
  tryReconnecting: boolean = true;

  constructor(
    clientId: TransportClientId,
    providedOptions?: Partial<TransportOptions>,
  ) {
    super(clientId, providedOptions);
    this.inflightConnectionPromises = new Map();
  }

  protected handleConnection(conn: ConnType, to: TransportClientId): void {
    const bootHandler = this.receiveWithBootSequence(conn, () => {
      // when we are done booting,
      // remove boot listener and use the normal message listener
      conn.removeDataListener(bootHandler);
      conn.addDataListener((data) => this.handleMsg(this.parseMsg(data)));
    });

    conn.addDataListener(bootHandler);
    conn.addCloseListener(() => {
      this.onDisconnect(conn, to);
      this.connect(to);
    });

    conn.addErrorListener((err) => {
      log?.warn(
        `${this.clientId} -- error in connection (id: ${conn.debugId}) to ${to}: ${err.message}`,
      );
    });
  }

  /**
   * Abstract method that creates a new {@link Connection} object.
   * This should call {@link handleConnection} when the connection is created.
   * The downstream client implementation needs to implement this.
   *
   * @param to The client ID of the node to connect to.
   * @returns The new connection object.
   */
  protected abstract createNewOutgoingConnection(
    to: TransportClientId,
  ): Promise<ConnType>;

  /**
   * Manually attempts to connect to a client.
   * @param to The client ID of the node to connect to.
   */
  async connect(to: TransportClientId, attempt = 0) {
    if (this.state !== 'open' || !this.tryReconnecting) {
      log?.info(
        `${this.clientId} -- transport state is no longer open, not attempting connection`,
      );
      return;
    }

    let reconnectPromise = this.inflightConnectionPromises.get(to);
    if (!reconnectPromise) {
      reconnectPromise = this.createNewOutgoingConnection(to);
      this.inflightConnectionPromises.set(to, reconnectPromise);
    }

    try {
      const conn = await reconnectPromise;
      if (this.state !== 'open') {
        // we only delete on open here as this allows us to cache successful
        // connection requests so that subsequent connect calls can reuse it until
        // it we know for sure that it is unhealthy
        this.inflightConnectionPromises.delete(to);
        conn.close();
        return;
      }

      // send boot sequence
      this.state = 'open';
      const responseMsg = bootRequestMessage(this.clientId, to);
      conn.send(this.codec.toBuffer(responseMsg));
    } catch (error: unknown) {
      const errStr = error instanceof Error ? error.message : `${error}`;

      // retry on failure
      this.inflightConnectionPromises.delete(to);
      if (attempt >= this.options.retryAttemptsMax) {
        const errMsg = `connection to ${to} failed after ${attempt} attempts (${errStr}), giving up`;
        log?.error(`${this.clientId} -- ${errMsg}`);
        throw new Error(errMsg);
      } else {
        // exponential backoff + jitter
        const jitter = Math.floor(Math.random() * this.options.retryJitterMs);
        const backoffMs = this.options.retryIntervalMs * 2 ** attempt + jitter;
        log?.warn(
          `${this.clientId} -- connection to ${to} failed (${errStr}), trying again in ${backoffMs}ms`,
        );
        setTimeout(() => this.connect(to, attempt + 1), backoffMs);
      }
    }
  }

  receiveWithBootSequence(
    conn: ConnType,
    sessionCb: (sess: Session<ConnType>) => void,
  ) {
    const bootHandler = (data: Uint8Array) => {
      const parsed = this.parseMsg(data);
      if (!parsed) return;

      if (!Value.Check(ControlMessageHandshakeResponseSchema, parsed.payload)) {
        log?.warn(
          `${
            this.clientId
          } -- received invalid handshake resp: ${JSON.stringify(parsed)}`,
        );
        return;
      }

      if (!parsed.payload.status.ok) {
        log?.warn(
          `${this.clientId} -- received failed handshake resp: ${JSON.stringify(
            parsed,
          )}`,
        );
        return;
      }

      // everything is ok
      // connect the session
      sessionCb(this.onConnect(conn, parsed.from));
    };

    return bootHandler;
  }

  onDisconnect(conn: ConnType, connectedTo: string | undefined): void {
    if (connectedTo) this.inflightConnectionPromises.delete(connectedTo);
    super.onDisconnect(conn, connectedTo);
  }
}

export abstract class ServerTransport<
  ConnType extends Connection,
> extends Transport<ConnType> {
  protected handleConnection(conn: ConnType) {
    let session: Session<ConnType> | undefined = undefined;
    const client = () => session?.to ?? 'unknown';
    const bootHandler = this.receiveWithBootSequence(
      conn,
      (establishedSession) => {
        session = establishedSession;

        // when we are done booting,
        // remove boot listener and use the normal message listener
        conn.removeDataListener(bootHandler);
        conn.addDataListener((data) => this.handleMsg(this.parseMsg(data)));
      },
    );

    conn.addDataListener(bootHandler);
    conn.addCloseListener(() => {
      if (!session) return;
      log?.info(
        `${this.clientId} -- connection (id: ${
          conn.debugId
        }) to ${client()} disconnected`,
      );
      this.onDisconnect(conn, session?.to);
    });

    conn.addErrorListener((err) => {
      if (!session) return;
      log?.warn(
        `${this.clientId} -- connection (id: ${
          conn.debugId
        }) to ${client()} got an error: ${err}`,
      );
    });
  }

  receiveWithBootSequence(
    conn: ConnType,
    sessionCb: (sess: Session<ConnType>) => void,
  ) {
    const bootHandler = (data: Uint8Array) => {
      const parsed = this.parseMsg(data);
      if (!parsed) return;

      // double check protocol version here
      if (!Value.Check(ControlMessageHandshakeRequestSchema, parsed.payload)) {
        const responseMsg = bootResponseMessage(
          this.clientId,
          parsed.from,
          false,
        );
        conn.send(this.codec.toBuffer(responseMsg));
        log?.warn(
          `${this.clientId} -- received invalid handshake msg: ${JSON.stringify(
            parsed,
          )}`,
        );
        return;
      }

      log?.debug(
        `${this.clientId} -- handshake from ${parsed.from} ok, responding with handshake success`,
      );
      const responseMsg = bootResponseMessage(this.clientId, parsed.from, true);
      conn.send(this.codec.toBuffer(responseMsg));

      // we have the session
      sessionCb(this.onConnect(conn, parsed.from));
    };

    return bootHandler;
  }
}
