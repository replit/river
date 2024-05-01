import { Codec } from '../codec/types';
import { Value } from '@sinclair/typebox/value';
import {
  OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
  TransportClientId,
  ControlMessageHandshakeRequestSchema,
  ControlMessageHandshakeResponseSchema,
  handshakeRequestMessage,
  handshakeResponseMessage,
  PartialTransportMessage,
  ControlFlags,
  ControlMessagePayloadSchema,
  isAck,
  PROTOCOL_VERSION,
} from './message';
import { log } from '../logging';
import {
  EventDispatcher,
  EventHandler,
  EventTypes,
  ProtocolError,
  ProtocolErrorType,
} from './events';
import { Connection, Session, SessionOptions } from './session';
import { Static } from '@sinclair/typebox';
import { coerceErrorString } from '../util/stringify';
import { ConnectionRetryOptions, LeakyBucketRateLimit } from './rateLimit';
import { NaiveJsonCodec } from '../codec';

/**
 * Represents the possible states of a transport.
 * @property {'open'} open - The transport is open and operational (note that this doesn't mean it is actively connected)
 * @property {'closed'} closed - The transport is closed and not operational, but can be reopened.
 * @property {'destroyed'} destroyed - The transport is permanently destroyed and cannot be reopened.
 */
export type TransportStatus = 'open' | 'closed' | 'destroyed';

type TransportOptions = SessionOptions;
export type ProvidedTransportOptions = Partial<TransportOptions>;
export const defaultTransportOptions: TransportOptions = {
  heartbeatIntervalMs: 1_000,
  heartbeatsUntilDead: 2,
  sessionDisconnectGraceMs: 5_000,
  codec: NaiveJsonCodec,
};

export type ProvidedClientTransportOptions = Partial<ClientTransportOptions>;
type ClientTransportOptions = SessionOptions & ConnectionRetryOptions;

const defaultConnectionRetryOptions: ConnectionRetryOptions = {
  baseIntervalMs: 250,
  maxJitterMs: 200,
  maxBackoffMs: 32_000,
  attemptBudgetCapacity: 5,
  budgetRestoreIntervalMs: 200,
};

const defaultClientTransportOptions: ClientTransportOptions = {
  ...defaultTransportOptions,
  ...defaultConnectionRetryOptions,
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
  protected options: TransportOptions;

  /**
   * Creates a new Transport instance.
   * This should also set up {@link onConnect}, and {@link onDisconnect} listeners.
   * @param codec The codec used to encode and decode messages.
   * @param clientId The client ID of this transport.
   */
  constructor(
    clientId: TransportClientId,
    providedOptions?: ProvidedTransportOptions,
  ) {
    this.options = { ...defaultTransportOptions, ...providedOptions };
    this.eventDispatcher = new EventDispatcher();
    this.sessions = new Map();
    this.codec = this.options.codec;
    this.clientId = clientId;
    this.state = 'open';
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
    advertisedSessionId: string,
  ): Session<ConnType> {
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'connect',
      conn,
    });

    // check if the peer we are connected to is actually different by comparing session id
    let oldSession = this.sessions.get(connectedTo);
    if (
      oldSession?.advertisedSessionId &&
      oldSession.advertisedSessionId !== advertisedSessionId
    ) {
      // mismatch, kill the old session and begin a new one
      log?.warn(
        `${this.clientId} -- connection from ${connectedTo} is a different session (id: ${advertisedSessionId}, last connected to: ${oldSession.advertisedSessionId}), starting a new session`,
      );
      this.deleteSession(oldSession);
      oldSession = undefined;
    }

    // if we don't have an existing session, create a new one and return it
    if (oldSession === undefined) {
      const newSession = this.createSession(connectedTo, conn);
      newSession.advertisedSessionId = advertisedSessionId;
      log?.info(
        `${this.clientId} -- new connection (id: ${conn.debugId}) for new session (id: ${newSession.id}) to ${connectedTo}`,
      );
      return newSession;
    }

    log?.info(
      `${this.clientId} -- new connection (id: ${conn.debugId}) for existing session (id: ${oldSession.id}) to ${connectedTo}`,
    );

    // otherwise, this is a new connection from the same user, let's consider
    // the old one as dead and call this connection canonical
    oldSession.replaceWithNewConnection(conn);
    oldSession.sendBufferedMessages();
    oldSession.advertisedSessionId = advertisedSessionId;
    return oldSession;
  }

  protected createSession(to: TransportClientId, conn?: ConnType) {
    const session = new Session<ConnType>(
      conn,
      this.clientId,
      to,
      this.options,
    );
    this.sessions.set(session.to, session);
    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'connect',
      session,
    });
    return session;
  }

  protected getOrCreateSession(to: TransportClientId, conn?: ConnType) {
    let session = this.sessions.get(to);
    if (!session) {
      session = this.createSession(to, conn);
      log?.info(
        `${this.clientId} -- no session for ${to}, created a new one (id: ${session.id})`,
      );
    }

    return session;
  }

  protected deleteSession(session: Session<ConnType>) {
    session.close();
    this.sessions.delete(session.to);
    log?.info(
      `${this.clientId} -- session ${session.id} disconnect from ${session.to}`,
    );
    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'disconnect',
      session,
    });
  }

  /**
   * The downstream implementation needs to call this when a connection is closed.
   * @param conn The connection object.
   * @param connectedTo The peer we are connected to.
   */
  protected onDisconnect(conn: ConnType, session: Session<ConnType>) {
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'disconnect',
      conn,
    });

    session.connection = undefined;
    session.beginGrace(() => this.deleteSession(session));
  }

  /**
   * Parses a message from a Uint8Array into a {@link OpaqueTransportMessage}.
   * @param msg The message to parse.
   * @returns The parsed message, or null if the message is malformed or invalid.
   */
  protected parseMsg(msg: Uint8Array): OpaqueTransportMessage | null {
    const parsedMsg = this.codec.fromBuffer(msg);

    if (parsedMsg === null) {
      const decodedBuffer = new TextDecoder().decode(Buffer.from(msg));
      log?.error(
        `${this.clientId} -- received malformed msg, killing conn: ${decodedBuffer}`,
      );
      return null;
    }

    if (!Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
      log?.error(
        `${this.clientId} -- received invalid msg: ${JSON.stringify(
          parsedMsg,
        )}`,
      );
      return null;
    }

    return parsedMsg;
  }

  /**
   * Called when a message is received by this transport.
   * You generally shouldn't need to override this in downstream transport implementations.
   * @param msg The received message.
   */
  protected handleMsg(msg: OpaqueTransportMessage) {
    if (this.state !== 'open') return;
    const session = this.sessions.get(msg.from);
    if (!session) {
      const err = `${this.clientId} -- (invariant violation) no existing session for ${msg.from}`;
      log?.error(err);
      return;
    }

    // got a msg so we know the other end is alive, reset the grace period
    session.cancelGrace();

    log?.debug(`${this.clientId} -- received msg: ${JSON.stringify(msg)}`);
    if (msg.seq !== session.nextExpectedSeq) {
      if (msg.seq < session.nextExpectedSeq) {
        log?.debug(
          `${this.clientId} -- received duplicate msg (got: ${
            msg.seq
          }, wanted: ${session.nextExpectedSeq}), discarding: ${JSON.stringify(
            msg,
          )}`,
        );
      } else {
        const errMsg = `received out-of-order msg (got seq: ${msg.seq}, wanted seq: ${session.nextExpectedSeq})`;
        log?.error(
          `${
            this.clientId
          } -- fatal: ${errMsg}, marking connection as dead: ${JSON.stringify(
            msg,
          )}`,
        );
        this.protocolError(ProtocolError.MessageOrderingViolated, errMsg);
        session.close();
      }

      return;
    }

    session.updateBookkeeping(msg.ack, msg.seq);

    // don't dispatch explicit acks
    if (!isAck(msg.controlFlags)) {
      this.eventDispatcher.dispatchEvent('message', msg);
    } else {
      log?.debug(`${this.clientId} -- discarding msg ${msg.id} (ack bit set)`);
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
   * @param the type of event to un-listen on
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
      this.protocolError(ProtocolError.UseAfterDestroy, err);
      return undefined;
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

    return this.getOrCreateSession(to).send(msg);
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

  protected protocolError(type: ProtocolErrorType, message: string) {
    this.eventDispatcher.dispatchEvent('protocolError', { type, message });
  }

  /**
   * Default close implementation for transports. You should override this in the downstream
   * implementation if you need to do any additional cleanup and call super.close() at the end.
   * Closes the transport. Any messages sent while the transport is closed will be silently discarded.
   */
  close() {
    this.state = 'closed';
    for (const session of this.sessions.values()) {
      this.deleteSession(session);
    }

    log?.info(`${this.clientId} -- manually closed transport`);
  }

  /**
   * Default destroy implementation for transports. You should override this in the downstream
   * implementation if you need to do any additional cleanup and call super.destroy() at the end.
   * Destroys the transport. Any messages sent while the transport is destroyed will throw an error.
   */
  destroy() {
    this.state = 'destroyed';
    for (const session of this.sessions.values()) {
      this.deleteSession(session);
    }

    log?.info(`${this.clientId} -- manually destroyed transport`);
  }
}

export abstract class ClientTransport<
  ConnType extends Connection,
> extends Transport<ConnType> {
  /**
   * The options for this transport.
   */
  protected options: ClientTransportOptions;

  /**
   * The map of reconnect promises for each client ID.
   */
  inflightConnectionPromises: Map<TransportClientId, Promise<ConnType>>;
  retryBudget: LeakyBucketRateLimit;

  /**
   * A flag indicating whether the transport should automatically reconnect
   * when a connection is dropped.
   * Realistically, this should always be true for clients unless you are writing
   * tests or a special case where you don't want to reconnect.
   */
  reconnectOnConnectionDrop = true;

  constructor(
    clientId: TransportClientId,
    providedOptions?: ProvidedClientTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.options = {
      ...defaultClientTransportOptions,
      ...providedOptions,
    };
    this.inflightConnectionPromises = new Map();
    this.retryBudget = new LeakyBucketRateLimit(this.options);
  }

  protected handleConnection(conn: ConnType, to: TransportClientId): void {
    if (this.state !== 'open') return;
    let session: Session<ConnType> | undefined = undefined;
    const handshakeHandler = (data: Uint8Array) => {
      const maybeSession = this.receiveHandshakeResponseMessage(data, conn);
      if (!maybeSession) {
        conn.close();
        return;
      } else {
        session = maybeSession;
      }

      // when we are done handshake sequence,
      // remove handshake listener and use the normal message listener
      conn.removeDataListener(handshakeHandler);
      conn.addDataListener((data) => {
        const parsed = this.parseMsg(data);
        if (!parsed) {
          conn.close();
          return;
        }

        this.handleMsg(parsed);
      });
    };

    conn.addDataListener(handshakeHandler);
    conn.addCloseListener(() => {
      if (session) {
        this.onDisconnect(conn, session);
      }
      log?.info(
        `${this.clientId} -- connection (id: ${conn.debugId}) to ${to} disconnected`,
      );
      this.inflightConnectionPromises.delete(to);
      if (this.reconnectOnConnectionDrop) {
        void this.connect(to);
      }
    });
    conn.addErrorListener((err) => {
      log?.warn(
        `${this.clientId} -- error in connection (id: ${
          conn.debugId
        }) to ${to}: ${coerceErrorString(err)}`,
      );
    });
  }

  receiveHandshakeResponseMessage(
    data: Uint8Array,
    conn: ConnType,
  ): Session<ConnType> | false {
    const parsed = this.parseMsg(data);
    if (!parsed) {
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'received non-transport message',
      );
      return false;
    }

    if (!Value.Check(ControlMessageHandshakeResponseSchema, parsed.payload)) {
      log?.warn(
        `${this.clientId} -- received invalid handshake resp: ${JSON.stringify(
          parsed,
        )}`,
      );
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'invalid handshake resp',
      );
      return false;
    }

    if (!parsed.payload.status.ok) {
      log?.warn(
        `${this.clientId} -- received failed handshake resp: ${JSON.stringify(
          parsed,
        )}`,
      );
      this.protocolError(
        ProtocolError.HandshakeFailed,
        parsed.payload.status.reason,
      );
      return false;
    }

    log?.debug(`${this.clientId} -- handshake from ${parsed.from} ok`);
    const session = this.onConnect(
      conn,
      parsed.from,
      parsed.payload.status.sessionId,
    );

    // After a successful connection, we start restoring the budget
    // so that the next time we try to connect, we don't hit the client
    // with backoff forever.
    this.retryBudget.startRestoringBudget(parsed.from);
    return session;
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
  async connect(to: TransportClientId): Promise<void> {
    const canProceedWithConnection = () => this.state === 'open';
    if (!canProceedWithConnection()) {
      log?.info(
        `${this.clientId} -- transport state is no longer open, cancelling attempt to connect to ${to}`,
      );
      return;
    }

    let reconnectPromise = this.inflightConnectionPromises.get(to);
    if (!reconnectPromise) {
      // check budget
      const budgetConsumed = this.retryBudget.getBudgetConsumed(to);
      if (!this.retryBudget.hasBudget(to)) {
        const errMsg = `tried to connect to ${to} but retry budget exceeded (more than ${budgetConsumed} attempts in the last ${this.retryBudget.totalBudgetRestoreTime}ms)`;
        log?.warn(`${this.clientId} -- ${errMsg}`);
        this.protocolError(ProtocolError.RetriesExceeded, errMsg);
        return;
      }

      let sleep = Promise.resolve();
      const backoffMs = this.retryBudget.getBackoffMs(to);
      if (backoffMs > 0) {
        sleep = new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      log?.info(
        `${this.clientId} -- attempting connection to ${to} (${backoffMs}ms backoff)`,
      );
      this.retryBudget.consumeBudget(to);
      reconnectPromise = sleep
        .then(() => {
          if (!canProceedWithConnection()) {
            throw new Error('transport state is no longer open');
          }
        })
        .then(() => this.createNewOutgoingConnection(to))
        .then((conn) => {
          if (!canProceedWithConnection()) {
            log?.info(
              `${this.clientId} -- transport state is no longer open, closing pre-handshake connection (id: ${conn.debugId}) to ${to}`,
            );
            conn.close();
            throw new Error('transport state is no longer open');
          }

          // only send handshake once per attempt
          this.sendHandshake(to, conn);
          return conn;
        });

      this.inflightConnectionPromises.set(to, reconnectPromise);
    } else {
      log?.info(
        `${this.clientId} -- attempting connection to ${to} (reusing previous attempt)`,
      );
    }

    try {
      await reconnectPromise;
    } catch (error: unknown) {
      this.inflightConnectionPromises.delete(to);
      const errStr = coerceErrorString(error);

      if (!this.reconnectOnConnectionDrop || !canProceedWithConnection()) {
        log?.warn(`${this.clientId} -- connection to ${to} failed (${errStr})`);
      } else {
        log?.warn(
          `${this.clientId} -- connection to ${to} failed (${errStr}), retrying`,
        );
        return this.connect(to);
      }
    }
  }

  protected deleteSession(session: Session<ConnType>) {
    this.inflightConnectionPromises.delete(session.to);
    super.deleteSession(session);
  }

  protected sendHandshake(to: TransportClientId, conn: ConnType) {
    const session = this.getOrCreateSession(to, conn);
    const requestMsg = handshakeRequestMessage(this.clientId, to, session.id);
    log?.debug(`${this.clientId} -- sending handshake request to ${to}`);
    conn.send(this.codec.toBuffer(requestMsg));
  }

  close() {
    this.retryBudget.close();
    super.close();
  }
}

export abstract class ServerTransport<
  ConnType extends Connection,
> extends Transport<ConnType> {
  constructor(
    clientId: TransportClientId,
    providedOptions?: ProvidedTransportOptions,
  ) {
    super(clientId, providedOptions);
    log?.info(
      `${this.clientId} -- initiated server transport (protocol: ${PROTOCOL_VERSION})`,
    );
  }

  protected handleConnection(conn: ConnType) {
    if (this.state !== 'open') return;

    log?.info(
      `${this.clientId} -- new incoming connection (id: ${conn.debugId})`,
    );
    let session: Session<ConnType> | undefined = undefined;
    const client = () => session?.to ?? 'unknown';
    const handshakeHandler = (data: Uint8Array) => {
      const maybeSession = this.receiveHandshakeRequestMessage(data, conn);
      if (!maybeSession) {
        conn.close();
        return;
      } else {
        session = maybeSession;
      }

      // when we are done handshake sequence,
      // remove handshake listener and use the normal message listener
      conn.removeDataListener(handshakeHandler);
      conn.addDataListener((data) => {
        const parsed = this.parseMsg(data);
        if (!parsed) {
          conn.close();
          return;
        }

        this.handleMsg(parsed);
      });
    };

    conn.addDataListener(handshakeHandler);
    conn.addCloseListener(() => {
      if (!session) return;
      log?.info(
        `${this.clientId} -- connection (id: ${
          conn.debugId
        }) to ${client()} disconnected`,
      );
      this.onDisconnect(conn, session);
    });

    conn.addErrorListener((err) => {
      if (!session) return;
      log?.warn(
        `${this.clientId} -- connection (id: ${
          conn.debugId
        }) to ${client()} got an error: ${coerceErrorString(err)}`,
      );
    });
  }

  receiveHandshakeRequestMessage(
    data: Uint8Array,
    conn: ConnType,
  ): Session<ConnType> | false {
    const parsed = this.parseMsg(data);
    if (!parsed) {
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'received non-transport message',
      );
      return false;
    }

    if (!Value.Check(ControlMessageHandshakeRequestSchema, parsed.payload)) {
      const reason = 'received invalid handshake msg';
      const responseMsg = handshakeResponseMessage(this.clientId, parsed.from, {
        ok: false,
        reason,
      });
      conn.send(this.codec.toBuffer(responseMsg));
      log?.warn(`${this.clientId} -- ${reason}: ${JSON.stringify(parsed)}`);
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'invalid handshake request',
      );
      return false;
    }

    // double check protocol version here
    const gotVersion = parsed.payload.protocolVersion;
    if (gotVersion !== PROTOCOL_VERSION) {
      const reason = `incorrect version (got: ${gotVersion} wanted ${PROTOCOL_VERSION})`;
      const responseMsg = handshakeResponseMessage(this.clientId, parsed.from, {
        ok: false,
        reason,
      });
      conn.send(this.codec.toBuffer(responseMsg));
      log?.warn(
        `${this.clientId} -- received handshake msg with incompatible protocol version (got: ${gotVersion}, expected: ${PROTOCOL_VERSION})`,
      );
      this.protocolError(ProtocolError.HandshakeFailed, reason);
      return false;
    }

    const session = this.getOrCreateSession(parsed.from, conn);
    log?.debug(
      `${this.clientId} -- handshake from ${parsed.from} ok, responding with handshake success`,
    );
    const responseMsg = handshakeResponseMessage(this.clientId, parsed.from, {
      ok: true,
      sessionId: session.id,
    });
    conn.send(this.codec.toBuffer(responseMsg));
    return this.onConnect(conn, parsed.from, parsed.payload.sessionId);
  }
}
