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
  ControlFlags,
  ControlMessagePayloadSchema,
  isAck,
  PROTOCOL_VERSION,
} from './message';
import { log } from '../logging';
import { EventDispatcher, EventHandler, EventTypes } from './events';
import { Connection, SESSION_DISCONNECT_GRACE_MS, Session } from './session';
import { NaiveJsonCodec } from '../codec';
import { Static } from '@sinclair/typebox';
import { nanoid } from 'nanoid';
import { coerceErrorString } from '../util/stringify';

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
export const DEFAULT_RECONNECT_JITTER_MAX_MS = 500;

/**
 * The default retry interval for reconnecting to a transport.
 * The actual interval is an exponent backoff calculated as follows:
 * ms = retryIntervalMs * (2 ** attempt) + jitter
 */
export const DEFAULT_RECONNECT_INTERVAL_MS = 250;
export const defaultTransportOptions: TransportOptions = {
  retryIntervalMs: DEFAULT_RECONNECT_INTERVAL_MS,
  retryJitterMs: DEFAULT_RECONNECT_JITTER_MAX_MS,
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
   * Unique per instance of the transport.
   * This allows us to distinguish reconnects to different
   * transports.
   */
  instanceId: string = nanoid();
  connectedInstanceIds = new Map<TransportClientId, string>();

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
    instanceId: string,
  ): Session<ConnType> {
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'connect',
      conn,
    });

    let oldSession = this.sessions.get(connectedTo);
    // check if the peer we are connected to is actually difference by comparing instanceId
    const lastInstanceId = this.connectedInstanceIds.get(connectedTo);
    if (
      oldSession &&
      lastInstanceId !== undefined &&
      lastInstanceId !== instanceId
    ) {
      // mismatch, kill the old session and begin a new one
      log?.warn(
        `${this.clientId} -- handshake from ${connectedTo} is a different instance (got: ${instanceId}, last connected to: ${lastInstanceId}), starting a new session`,
      );
      oldSession.close();
      this.deleteSession(oldSession);
      oldSession = undefined;
    }
    this.connectedInstanceIds.set(connectedTo, instanceId);

    // if we don't have an existing session, create a new one and return it
    if (oldSession === undefined) {
      const newSession = this.createSession(connectedTo, conn);
      log?.info(
        `${this.clientId} -- new connection (id: ${conn.debugId}) for new session (id: ${newSession.debugId}) to ${connectedTo}`,
      );
      return newSession;
    }

    log?.info(
      `${this.clientId} -- new connection (id: ${conn.debugId}) for existing session (id: ${oldSession.debugId}) to ${connectedTo}`,
    );

    // otherwise, this is a new connection from the same user, let's consider
    // the old one as dead and call this connection canonical
    oldSession.replaceWithNewConnection(conn);
    oldSession.sendBufferedMessages();
    return oldSession;
  }

  private createSession(
    connectedTo: TransportClientId,
    conn: ConnType | undefined,
  ) {
    const session = new Session<ConnType>(
      this.codec,
      this.clientId,
      connectedTo,
      conn,
    );
    this.sessions.set(session.to, session);
    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'connect',
      session,
    });
    return session;
  }

  protected deleteSession(session: Session<ConnType>) {
    this.sessions.delete(session.to);
    log?.info(
      `${this.clientId} -- session ${session.debugId} disconnect from ${session.to}`,
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
  protected onDisconnect(conn: ConnType, connectedTo: TransportClientId) {
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'disconnect',
      conn,
    });

    if (this.state !== 'open') {
      // construct a fake session and disconnect it immediately
      conn.close();
      this.sessions.delete(connectedTo);
      return;
    }

    const session = this.sessionByClientId(connectedTo);
    log?.info(
      `${this.clientId} -- connection (id: ${conn.debugId}) disconnect from ${connectedTo}, ${SESSION_DISCONNECT_GRACE_MS}ms until session (id: ${session.debugId}) disconnect`,
    );

    session.closeStaleConnection(conn);
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
      const decodedBuffer = new TextDecoder().decode(msg);
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
  protected handleMsg(msg: OpaqueTransportMessage) {
    if (this.state !== 'open') return;

    // got a msg so we know the other end is alive, reset the grace period
    const session = this.sessionByClientId(msg.from);
    session.cancelGrace();

    log?.debug(`${this.clientId} -- received msg: ${JSON.stringify(msg)}`);
    if (msg.seq !== session.nextExpectedSeq) {
      log?.warn(
        `${this.clientId} -- received out-of-order msg (got: ${
          msg.seq
        }, wanted: ${session.nextExpectedSeq}), discarding: ${JSON.stringify(
          msg,
        )}`,
      );
      return;
    }

    if (!isAck(msg.controlFlags)) {
      this.eventDispatcher.dispatchEvent('message', msg);
    }

    session.updateBookkeeping(msg.ack, msg.seq);
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

    return session.send(msg);
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

  /**
   * Default close implementation for transports. You should override this in the downstream
   * implementation if you need to do any additional cleanup and call super.close() at the end.
   * Closes the transport. Any messages sent while the transport is closed will be silently discarded.
   */
  close() {
    this.state = 'closed';
    for (const session of this.sessions.values()) {
      session.close();
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
      session.close();
      this.deleteSession(session);
    }

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
  tryReconnecting = true;

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
      conn.addDataListener((data) => {
        const parsed = this.parseMsg(data);
        if (!parsed) {
          conn.close();
          return;
        }

        this.handleMsg(parsed);
      });
    });

    conn.addDataListener(bootHandler);
    conn.addCloseListener(() => {
      this.onDisconnect(conn, to);
      void this.connect(to);
    });

    conn.addErrorListener((err) => {
      log?.warn(
        `${this.clientId} -- error in connection (id: ${
          conn.debugId
        }) to ${to}: ${coerceErrorString(err)}`,
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

      // send boot sequence
      this.state = 'open';
      const requestMsg = bootRequestMessage(this.clientId, to, this.instanceId);
      log?.debug(`${this.clientId} -- sending boot handshake to ${to}`);
      conn.send(this.codec.toBuffer(requestMsg));
    } catch (error: unknown) {
      const errStr = coerceErrorString(error);

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
        setTimeout(() => void this.connect(to, attempt + 1), backoffMs);
      }
    }
  }

  private receiveWithBootSequence(
    conn: ConnType,
    sessionCb: (sess: Session<ConnType>) => void,
  ) {
    const bootHandler = (data: Uint8Array) => {
      const parsed = this.parseMsg(data);
      if (!parsed) {
        conn.close();
        return;
      }

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

      // handshake ok, check if server instance matches
      const serverInstanceId = parsed.payload.status.instanceId;

      // all good, let's connect
      log?.debug(
        `${this.clientId} -- handshake from ${parsed.from} ok (server instance: ${serverInstanceId})`,
      );
      sessionCb(this.onConnect(conn, parsed.from, serverInstanceId));
    };

    return bootHandler;
  }

  protected onDisconnect(conn: ConnType, connectedTo: string): void {
    this.inflightConnectionPromises.delete(connectedTo);
    super.onDisconnect(conn, connectedTo);
  }
}

export abstract class ServerTransport<
  ConnType extends Connection,
> extends Transport<ConnType> {
  constructor(
    clientId: TransportClientId,
    providedOptions?: Partial<TransportOptions>,
  ) {
    super(clientId, providedOptions);
    log?.info(
      `${this.clientId} -- initiated server transport (instance id: ${this.instanceId}, protocol: ${PROTOCOL_VERSION})`,
    );
  }

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
        conn.addDataListener((data) => {
          const parsed = this.parseMsg(data);
          if (!parsed) {
            conn.close();
            return;
          }

          this.handleMsg(parsed);
        });
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
      this.onDisconnect(conn, session.to);
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

  protected receiveWithBootSequence(
    conn: ConnType,
    sessionCb: (sess: Session<ConnType>) => void,
  ) {
    const bootHandler = (data: Uint8Array) => {
      const parsed = this.parseMsg(data);
      if (!parsed) {
        conn.close();
        return;
      }

      // double check protocol version here
      if (!Value.Check(ControlMessageHandshakeRequestSchema, parsed.payload)) {
        const responseMsg = bootResponseMessage(
          this.clientId,
          this.instanceId,
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

      const instanceId = parsed.payload.instanceId;
      log?.debug(
        `${this.clientId} -- handshake from ${parsed.from} ok (instance id: ${instanceId}), responding with handshake success`,
      );
      const responseMsg = bootResponseMessage(
        this.clientId,
        this.instanceId,
        parsed.from,
        true,
      );
      conn.send(this.codec.toBuffer(responseMsg));

      // we have the session
      sessionCb(this.onConnect(conn, parsed.from, instanceId));
    };

    return bootHandler;
  }
}
