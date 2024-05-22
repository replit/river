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
  ClientHandshakeOptions,
  ServerHandshakeOptions,
  HandshakeRequestMetadata,
} from './message';
import { log } from '../logging/log';
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
import tracer, {
  PropagationContext,
  createConnectionTelemetryInfo,
  getPropagationContext,
} from '../tracing';
import { SpanStatusCode } from '@opentelemetry/api';

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

type ClientTransportOptions = TransportOptions &
  ConnectionRetryOptions & { handshake?: ClientHandshakeOptions };

export type ProvidedClientTransportOptions = Partial<ClientTransportOptions>;

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

type ServerTransportOptions = TransportOptions & {
  handshake?: ServerHandshakeOptions;
};

export type ProvidedServerTransportOptions = Partial<ServerTransportOptions>;

const defaultServerTransportOptions: ServerTransportOptions = {
  ...defaultTransportOptions,
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
    session: Session<ConnType>,
    isReconnect: boolean,
  ) {
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'connect',
      conn,
    });

    conn.telemetry = createConnectionTelemetryInfo(
      conn,
      session.telemetry.span,
    );

    if (isReconnect) {
      session.replaceWithNewConnection(conn);
      log?.info(`reconnected to ${connectedTo}`, session.loggingMetadata);
    }
  }

  protected createSession(
    to: TransportClientId,
    conn?: ConnType,
    propagationCtx?: PropagationContext,
  ) {
    const session = new Session<ConnType>(
      conn,
      this.clientId,
      to,
      this.options,
      propagationCtx,
    );
    this.sessions.set(session.to, session);
    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'connect',
      session,
    });
    return session;
  }

  protected getOrCreateSession(
    to: TransportClientId,
    conn?: ConnType,
    sessionId?: string,
    propagationCtx?: PropagationContext,
  ) {
    let session = this.sessions.get(to);
    let isReconnect = session !== undefined;

    if (
      session?.advertisedSessionId !== undefined &&
      sessionId !== undefined &&
      session.advertisedSessionId !== sessionId
    ) {
      log?.info(
        `session for ${to} already exists but has a different session id (expected: ${session.advertisedSessionId}, got: ${sessionId}), creating a new one`,
        session.loggingMetadata,
      );
      this.deleteSession(session);
      isReconnect = false;
      session = undefined;
    }

    if (!session) {
      session = this.createSession(to, conn, propagationCtx);
      log?.info(
        `no session for ${to}, created a new one`,
        session.loggingMetadata,
      );
    }

    if (sessionId !== undefined) {
      session.advertisedSessionId = sessionId;
    }

    return { session, isReconnect };
  }

  protected deleteSession(session: Session<ConnType>) {
    session.close();
    session.telemetry.span.end();
    this.sessions.delete(session.to);
    log?.info(
      `session ${session.id} disconnect from ${session.to}`,
      session.loggingMetadata,
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
    conn.telemetry?.span.end();
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'disconnect',
      conn,
    });

    session.connection = undefined;
    session.beginGrace(() => {
      session.telemetry.span.addEvent('session grace period expired');
      this.deleteSession(session);
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
      const decodedBuffer = new TextDecoder().decode(Buffer.from(msg));
      log?.error(`received malformed msg, killing conn: ${decodedBuffer}`, {
        clientId: this.clientId,
      });
      return null;
    }

    if (!Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
      log?.error(`received invalid msg: ${JSON.stringify(parsedMsg)}`, {
        clientId: this.clientId,
      });
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
      log?.error(`no existing session for ${msg.from}`, {
        clientId: this.clientId,
        fullTransportMessage: msg,
        tags: ['invariant-violation'],
      });
      return;
    }

    // got a msg so we know the other end is alive, reset the grace period
    session.cancelGrace();

    log?.debug(`received msg`, {
      clientId: this.clientId,
      fullTransportMessage: msg,
    });
    if (msg.seq !== session.nextExpectedSeq) {
      if (msg.seq < session.nextExpectedSeq) {
        log?.debug(
          `received duplicate msg (got seq: ${msg.seq}, wanted seq: ${session.nextExpectedSeq}), discarding`,
          { clientId: this.clientId, fullTransportMessage: msg },
        );
      } else {
        const errMsg = `received out-of-order msg (got seq: ${msg.seq}, wanted seq: ${session.nextExpectedSeq})`;
        log?.error(`${errMsg}, marking connection as dead`, {
          clientId: this.clientId,
          fullTransportMessage: msg,
          tags: ['invariant-violation'],
        });
        this.protocolError(ProtocolError.MessageOrderingViolated, errMsg);
        session.telemetry.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'message order violated',
        });
        session.close();
      }

      return;
    }

    session.updateBookkeeping(msg.ack, msg.seq);

    // don't dispatch explicit acks
    if (!isAck(msg.controlFlags)) {
      this.eventDispatcher.dispatchEvent('message', msg);
    } else {
      log?.debug(`discarding msg (ack bit set)`, {
        clientId: this.clientId,
        fullTransportMessage: msg,
      });
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
      log?.error(err, {
        clientId: this.clientId,
        partialTransportMessage: msg,
        tags: ['invariant-violation'],
      });
      this.protocolError(ProtocolError.UseAfterDestroy, err);
      return undefined;
    } else if (this.state === 'closed') {
      log?.info(`transport closed when sending, discarding`, {
        clientId: this.clientId,
        partialTransportMessage: msg,
      });
      return undefined;
    }

    return this.getOrCreateSession(to).session.send(msg);
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

    log?.info(`manually closed transport`, { clientId: this.clientId });
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

    log?.info(`manually destroyed transport`, { clientId: this.clientId });
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

    // kill the conn after the grace period if we haven't received a handshake
    const handshakeTimeout = setTimeout(() => {
      if (!session) {
        log?.warn(
          `connection to ${to} timed out waiting for handshake, closing`,
          { clientId: this.clientId, connectedTo: to, connId: conn.id },
        );
        conn.close();
      }
    }, this.options.sessionDisconnectGraceMs);

    const handshakeHandler = (data: Uint8Array) => {
      const maybeSession = this.receiveHandshakeResponseMessage(data, conn);
      if (!maybeSession) {
        conn.close();
        return;
      } else {
        session = maybeSession;
        clearTimeout(handshakeTimeout);
      }

      // when we are done handshake sequence,
      // remove handshake listener and use the normal message listener
      conn.removeDataListener(handshakeHandler);
      conn.addDataListener((data) => {
        const parsed = this.parseMsg(data);
        if (!parsed) {
          conn.telemetry?.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: 'message parse failure',
          });
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
      log?.info(`connection to ${to} disconnected`, {
        ...session?.loggingMetadata,
        clientId: this.clientId,
        connectedTo: to,
      });
      this.inflightConnectionPromises.delete(to);
      if (this.reconnectOnConnectionDrop) {
        void this.connect(to);
      }
    });
    conn.addErrorListener((err) => {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'connection error',
      });
      log?.warn(`error in connection to ${to}: ${coerceErrorString(err)}`, {
        ...session?.loggingMetadata,
        clientId: this.clientId,
        connectedTo: to,
      });
    });
  }

  receiveHandshakeResponseMessage(
    data: Uint8Array,
    conn: ConnType,
  ): Session<ConnType> | false {
    const parsed = this.parseMsg(data);
    if (!parsed) {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'non-transport message',
      });
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'received non-transport message',
      );
      return false;
    }

    if (!Value.Check(ControlMessageHandshakeResponseSchema, parsed.payload)) {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'invalid handshake response',
      });
      log?.warn(`received invalid handshake resp`, {
        clientId: this.clientId,
        connectedTo: parsed.from,
        fullTransportMessage: parsed,
      });
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'invalid handshake resp',
      );
      return false;
    }

    if (!parsed.payload.status.ok) {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'handshake rejected',
      });
      log?.warn(`received handshake rejection`, {
        clientId: this.clientId,
        connectedTo: parsed.from,
        fullTransportMessage: parsed,
      });
      this.protocolError(
        ProtocolError.HandshakeFailed,
        parsed.payload.status.reason,
      );
      return false;
    }

    log?.debug(`handshake from ${parsed.from} ok`, {
      clientId: this.clientId,
      connectedTo: parsed.from,
      fullTransportMessage: parsed,
    });

    const { session, isReconnect } = this.getOrCreateSession(
      parsed.from,
      conn,
      parsed.payload.status.sessionId,
    );

    this.onConnect(conn, parsed.from, session, isReconnect);

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
        `transport state is no longer open, cancelling attempt to connect to ${to}`,
        { clientId: this.clientId, connectedTo: to },
      );
      return;
    }

    let reconnectPromise = this.inflightConnectionPromises.get(to);
    if (!reconnectPromise) {
      // check budget
      const budgetConsumed = this.retryBudget.getBudgetConsumed(to);
      if (!this.retryBudget.hasBudget(to)) {
        const errMsg = `tried to connect to ${to} but retry budget exceeded (more than ${budgetConsumed} attempts in the last ${this.retryBudget.totalBudgetRestoreTime}ms)`;
        log?.warn(errMsg, { clientId: this.clientId, connectedTo: to });
        this.protocolError(ProtocolError.RetriesExceeded, errMsg);
        return;
      }

      let sleep = Promise.resolve();
      const backoffMs = this.retryBudget.getBackoffMs(to);
      if (backoffMs > 0) {
        sleep = new Promise((resolve) => setTimeout(resolve, backoffMs));
      }

      log?.info(`attempting connection to ${to} (${backoffMs}ms backoff)`, {
        clientId: this.clientId,
        connectedTo: to,
      });
      this.retryBudget.consumeBudget(to);
      reconnectPromise = tracer.startActiveSpan('connect', async (span) => {
        try {
          span.addEvent('backoff', { backoffMs });
          await sleep;
          if (!canProceedWithConnection()) {
            throw new Error('transport state is no longer open');
          }

          span.addEvent('connecting');
          const conn = await this.createNewOutgoingConnection(to);
          if (!canProceedWithConnection()) {
            log?.info(
              `transport state is no longer open, closing pre-handshake connection to ${to}`,
              {
                clientId: this.clientId,
                connectedTo: to,
                connId: conn.id,
              },
            );
            conn.close();
            throw new Error('transport state is no longer open');
          }

          span.addEvent('sending handshake');
          const ok = await this.sendHandshake(to, conn);
          if (!ok) {
            conn.close();
            throw new Error('failed to send handshake');
          }

          return conn;
        } catch (err) {
          // rethrow the error so that the promise is rejected
          // as it was before we wrapped it in a span
          const errStr = coerceErrorString(err);
          span.recordException(errStr);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      });

      this.inflightConnectionPromises.set(to, reconnectPromise);
    } else {
      log?.info(`attempting connection to ${to} (reusing previous attempt)`, {
        clientId: this.clientId,
        connectedTo: to,
      });
    }

    try {
      await reconnectPromise;
    } catch (error: unknown) {
      this.inflightConnectionPromises.delete(to);
      const errStr = coerceErrorString(error);

      if (!this.reconnectOnConnectionDrop || !canProceedWithConnection()) {
        log?.warn(`connection to ${to} failed (${errStr})`, {
          clientId: this.clientId,
          connectedTo: to,
        });
      } else {
        log?.warn(`connection to ${to} failed (${errStr}), retrying`, {
          clientId: this.clientId,
          connectedTo: to,
        });
        return this.connect(to);
      }
    }
  }

  protected deleteSession(session: Session<ConnType>) {
    this.inflightConnectionPromises.delete(session.to);
    super.deleteSession(session);
  }

  protected async sendHandshake(to: TransportClientId, conn: ConnType) {
    let metadata: HandshakeRequestMetadata | undefined;

    if (this.options.handshake) {
      metadata = await this.options.handshake.get();

      if (!Value.Check(this.options.handshake.schema, metadata)) {
        log?.error(`handshake metadata did not match schema`, {
          clientId: this.clientId,
          connectedTo: to,
          tags: ['invariant-violation'],
        });
        this.protocolError(
          ProtocolError.HandshakeFailed,
          'handshake metadata did not match schema',
        );
        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'handshake meta mismatch',
        });
        return false;
      }
    }

    const { session } = this.getOrCreateSession(to, conn);
    const requestMsg = handshakeRequestMessage(
      this.clientId,
      to,
      session.id,
      metadata,
      getPropagationContext(session.telemetry.ctx),
    );
    log?.debug(`sending handshake request to ${to}`, {
      clientId: this.clientId,
      connectedTo: to,
    });
    conn.send(this.codec.toBuffer(requestMsg));
    return true;
  }

  close() {
    this.retryBudget.close();
    super.close();
  }
}

export abstract class ServerTransport<
  ConnType extends Connection,
> extends Transport<ConnType> {
  /**
   * The options for this transport.
   */
  protected options: ServerTransportOptions;

  constructor(
    clientId: TransportClientId,
    providedOptions?: ProvidedServerTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.options = {
      ...defaultServerTransportOptions,
      ...providedOptions,
    };
    log?.info(`initiated server transport`, {
      clientId: this.clientId,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  protected handleConnection(conn: ConnType) {
    if (this.state !== 'open') return;

    log?.info(`new incoming connection`, {
      clientId: this.clientId,
      connId: conn.id,
    });

    let session: Session<ConnType> | undefined = undefined;
    const client = () => session?.to ?? 'unknown';

    // kill the conn after the grace period if we haven't received a handshake
    const handshakeTimeout = setTimeout(() => {
      if (!session) {
        log?.warn(
          `connection to ${client()} timed out waiting for handshake, closing`,
          {
            clientId: this.clientId,
            connectedTo: client(),
            connId: conn.id,
          },
        );
        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'handshake timeout',
        });
        conn.close();
      }
    }, this.options.sessionDisconnectGraceMs);

    const buffer: Array<Uint8Array> = [];
    let receivedHandshakeMessage = false;

    const handshakeHandler = (data: Uint8Array) => {
      // if we've already received, just buffer the data
      if (receivedHandshakeMessage) {
        buffer.push(data);
        return;
      }

      receivedHandshakeMessage = true;
      clearTimeout(handshakeTimeout);

      void this.receiveHandshakeRequestMessage(data, conn).then(
        (maybeSession) => {
          if (!maybeSession) {
            conn.close();
            return;
          }

          session = maybeSession;

          // when we are done handshake sequence,
          // remove handshake listener and use the normal message listener
          const dataHandler = (data: Uint8Array) => {
            const parsed = this.parseMsg(data);
            if (!parsed) {
              conn.close();
              return;
            }

            this.handleMsg(parsed);
          };

          // process any data we missed
          for (const data of buffer) {
            dataHandler(data);
          }

          conn.removeDataListener(handshakeHandler);
          conn.addDataListener(dataHandler);
          buffer.length = 0;
        },
      );
    };

    conn.addDataListener(handshakeHandler);
    conn.addCloseListener(() => {
      if (!session) return;
      log?.info(`connection to ${client()} disconnected`, {
        clientId: this.clientId,
        connId: conn.id,
      });
      this.onDisconnect(conn, session);
    });

    conn.addErrorListener((err) => {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'connection error',
      });
      if (!session) return;
      log?.warn(
        `connection to ${client()} got an error: ${coerceErrorString(err)}`,
        { clientId: this.clientId, connId: conn.id },
      );
    });
  }

  async receiveHandshakeRequestMessage(
    data: Uint8Array,
    conn: ConnType,
  ): Promise<Session<ConnType> | false> {
    const parsed = this.parseMsg(data);
    if (!parsed) {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'non-transport message',
      });
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'received non-transport message',
      );
      return false;
    }

    if (!Value.Check(ControlMessageHandshakeRequestSchema, parsed.payload)) {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'invalid handshake request',
      });
      const reason = 'received invalid handshake msg';
      const responseMsg = handshakeResponseMessage(this.clientId, parsed.from, {
        ok: false,
        reason,
      });
      conn.send(this.codec.toBuffer(responseMsg));
      // note: do _not_ log the payload, it may contain secrets
      const logData = { ...(parsed.payload ?? {}), metadata: 'redacted' };
      log?.warn(reason, {
        clientId: this.clientId,
        connId: conn.id,
        partialTransportMessage: { ...parsed, payload: logData },
      });
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'invalid handshake request',
      );
      return false;
    }

    // double check protocol version here
    const gotVersion = parsed.payload.protocolVersion;
    if (gotVersion !== PROTOCOL_VERSION) {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'incorrect protocol version',
      });

      const reason = `incorrect version (got: ${gotVersion} wanted ${PROTOCOL_VERSION})`;
      const responseMsg = handshakeResponseMessage(this.clientId, parsed.from, {
        ok: false,
        reason,
      });
      conn.send(this.codec.toBuffer(responseMsg));
      log?.warn(
        `received handshake msg with incompatible protocol version (got: ${gotVersion}, expected: ${PROTOCOL_VERSION})`,
        { clientId: this.clientId, connId: conn.id },
      );
      this.protocolError(ProtocolError.HandshakeFailed, reason);
      return false;
    }

    const { session, isReconnect } = this.getOrCreateSession(
      parsed.from,
      conn,
      parsed.payload.sessionId,
      parsed.tracing,
    );

    let handshakeMetadata: HandshakeRequestMetadata | undefined;

    if (this.options.handshake) {
      // check that the metadata that was sent is the correct shape
      if (
        !Value.Check(
          this.options.handshake.requestSchema,
          parsed.payload.metadata,
        )
      ) {
        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'malformed handshake meta',
        });
        const reason = 'received malformed handshake metadata';
        const responseMsg = handshakeResponseMessage(
          this.clientId,
          parsed.from,
          { ok: false, reason },
        );
        conn.send(this.codec.toBuffer(responseMsg));
        // note: do _not_ log the metadata, it may contain secrets
        log?.warn(`received malformed handshake metadata from ${parsed.from}`, {
          clientId: this.clientId,
          connId: conn.id,
        });
        this.protocolError(ProtocolError.HandshakeFailed, reason);
        this.deleteSession(session);
        return false;
      }

      const parsedMetadata = await this.options.handshake.parse(
        parsed.payload.metadata as HandshakeRequestMetadata,
        session,
        isReconnect,
      );

      // handler rejected the connection
      if (parsedMetadata === false) {
        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'rejected by handshake handler',
        });
        const reason = 'rejected by handshake handler';
        const responseMsg = handshakeResponseMessage(
          this.clientId,
          parsed.from,
          { ok: false, reason },
        );
        conn.send(this.codec.toBuffer(responseMsg));
        log?.warn(`rejected handshake from ${parsed.from}`, {
          clientId: this.clientId,
          connId: conn.id,
        });
        this.protocolError(ProtocolError.HandshakeFailed, reason);
        this.deleteSession(session);
        return false;
      }

      // check that the parsed metadata is the correct shape
      if (!Value.Check(this.options.handshake.parsedSchema, parsedMetadata)) {
        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'malformed handshake meta',
        });
        const reason = 'failed to parse handshake metadata';
        const responseMsg = handshakeResponseMessage(
          this.clientId,
          parsed.from,
          { ok: false, reason },
        );
        conn.send(this.codec.toBuffer(responseMsg));
        // note: do _not_ log the metadata, it may contain secrets
        log?.error(`failed to parse handshake metadata`, {
          clientId: this.clientId,
          connId: conn.id,
        });
        this.protocolError(ProtocolError.HandshakeFailed, reason);
        this.deleteSession(session);
        return false;
      }

      handshakeMetadata = parsedMetadata;
    }

    handshakeMetadata ??= {} as HandshakeRequestMetadata;
    session.metadata = handshakeMetadata;

    log?.debug(
      `handshake from ${parsed.from} ok, responding with handshake success`,
      { clientId: this.clientId, connId: conn.id },
    );
    const responseMsg = handshakeResponseMessage(this.clientId, parsed.from, {
      ok: true,
      sessionId: session.id,
    });
    conn.send(this.codec.toBuffer(responseMsg));
    this.onConnect(conn, parsed.from, session, isReconnect);

    return session;
  }
}
