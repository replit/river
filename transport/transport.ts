import { Codec } from '../codec/types';
import { Value } from '@sinclair/typebox/value';
import {
  OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
  TransportClientId,
  PartialTransportMessage,
  ControlFlags,
  ControlMessagePayloadSchema,
  isAck,
} from './message';
import {
  BaseLogger,
  LogFn,
  Logger,
  LoggingLevel,
  createLogProxy,
} from '../logging/log';
import {
  EventDispatcher,
  EventHandler,
  EventTypes,
  ProtocolError,
  ProtocolErrorType,
} from './events';
import { Connection, Session } from './session';
import { Static } from '@sinclair/typebox';
import { PropagationContext, createConnectionTelemetryInfo } from '../tracing';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  ProvidedTransportOptions,
  TransportOptions,
  defaultTransportOptions,
} from './options';

/**
 * Represents the possible states of a transport.
 * @property {'open'} open - The transport is open and operational (note that this doesn't mean it is actively connected)
 * @property {'closed'} closed - The transport is permanently closed and cannot be reopened.
 */
export type TransportStatus = 'open' | 'closed';

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
   * The status of the transport.
   */
  private status: TransportStatus;

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
  log?: Logger;

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
    this.status = 'open';
  }

  bindLogger(fn: LogFn | Logger, level?: LoggingLevel) {
    // construct logger from fn
    if (typeof fn === 'function') {
      this.log = createLogProxy(new BaseLogger(fn, level));
      return;
    }

    // object case, just assign
    this.log = createLogProxy(fn);
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
    session: Session<ConnType>,
    isTransparentReconnect: boolean,
  ) {
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'connect',
      conn,
    });

    conn.telemetry = createConnectionTelemetryInfo(conn, session.telemetry);

    session.replaceWithNewConnection(conn, isTransparentReconnect);

    this.log?.info(`connected to ${session.to}`, {
      ...conn.loggingMetadata,
      ...session.loggingMetadata,
    });
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

    if (this.log) {
      session.bindLogger(this.log);
    }

    this.sessions.set(session.to, session);
    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'connect',
      session,
    });
    return session;
  }

  protected getOrCreateSession({
    to,
    conn,
    handshakingConn,
    sessionId,
    propagationCtx,
  }: {
    to: TransportClientId;
    conn?: ConnType;
    handshakingConn?: ConnType;
    sessionId?: string;
    propagationCtx?: PropagationContext;
  }) {
    let session = this.sessions.get(to);
    const isReconnect = session !== undefined;
    let isTransparentReconnect = isReconnect;

    if (
      session?.advertisedSessionId !== undefined &&
      sessionId !== undefined &&
      session.advertisedSessionId !== sessionId
    ) {
      this.log?.info(
        `session for ${to} already exists but has a different session id (expected: ${session.advertisedSessionId}, got: ${sessionId}), creating a new one`,
        session.loggingMetadata,
      );
      // note that here we are only interested in closing the handshaking connection if it _does
      // not_ match the current handshaking connection. otherwise we can be in a situation where we
      // can accidentally close the current connection and are never able to establish a full
      // handshake.
      this.deleteSession({
        session,
        closeHandshakingConnection: handshakingConn !== undefined,
        handshakingConn,
      });
      isTransparentReconnect = false;
      session = undefined;
    }

    if (!session) {
      session = this.createSession(to, conn, propagationCtx);
      this.log?.info(
        `no session for ${to}, created a new one`,
        session.loggingMetadata,
      );
    }

    if (sessionId !== undefined) {
      session.advertisedSessionId = sessionId;
    }

    if (handshakingConn !== undefined) {
      session.replaceWithNewHandshakingConnection(handshakingConn);
    }
    return { session, isReconnect, isTransparentReconnect };
  }

  protected deleteSession({
    session,
    closeHandshakingConnection,
    handshakingConn,
  }: {
    session: Session<ConnType>;
    closeHandshakingConnection: boolean;
    handshakingConn?: ConnType;
  }) {
    if (closeHandshakingConnection) {
      session.closeHandshakingConnection(handshakingConn);
    }
    session.close();
    session.telemetry.span.end();
    this.sessions.delete(session.to);
    this.log?.info(
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
    if (session.connection !== undefined && session.connection.id !== conn.id) {
      // it is completely legal for us to receive the onDisconnect notification later down the line
      // and accidentally try to install the grace notification into an already-reconnected session.
      session.telemetry.span.addEvent('onDisconnect race');
      this.log?.warn('onDisconnect race', {
        clientId: this.clientId,
        ...session.loggingMetadata,
        ...conn.loggingMetadata,
        tags: ['invariant-violation'],
      });
      return;
    }
    conn.telemetry?.span.end();
    this.eventDispatcher.dispatchEvent('connectionStatus', {
      status: 'disconnect',
      conn,
    });

    session.connection = undefined;
    session.beginGrace(() => {
      if (session.connection !== undefined) {
        // if for whatever reason the session has a connection, it means that we accidentally
        // installed a grace period in a session that already had reconnected. oops.
        session.telemetry.span.addEvent('session grace period race');
        this.log?.warn('session grace period race', {
          clientId: this.clientId,
          ...session.loggingMetadata,
          ...conn.loggingMetadata,
          tags: ['invariant-violation'],
        });
        return;
      }
      session.telemetry.span.addEvent('session grace period expired');
      this.deleteSession({
        session,
        closeHandshakingConnection: true,
        handshakingConn: conn,
      });
    });
  }

  /**
   * Parses a message from a Uint8Array into a {@link OpaqueTransportMessage}.
   * @param msg The message to parse.
   * @returns The parsed message, or null if the message is malformed or invalid.
   */
  protected parseMsg(
    msg: Uint8Array,
    conn: ConnType,
  ): OpaqueTransportMessage | null {
    const parsedMsg = this.codec.fromBuffer(msg);

    if (parsedMsg === null) {
      const decodedBuffer = new TextDecoder().decode(Buffer.from(msg));
      this.log?.error(
        `received malformed msg, killing conn: ${decodedBuffer}`,
        {
          clientId: this.clientId,
          ...conn.loggingMetadata,
        },
      );
      return null;
    }

    if (!Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
      this.log?.error(`received invalid msg: ${JSON.stringify(parsedMsg)}`, {
        clientId: this.clientId,
        ...conn.loggingMetadata,
        validationErrors: [
          ...Value.Errors(OpaqueTransportMessageSchema, parsedMsg),
        ],
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
  protected handleMsg(msg: OpaqueTransportMessage, conn: ConnType) {
    if (this.getStatus() !== 'open') return;
    const session = this.sessions.get(msg.from);
    if (!session) {
      this.log?.error(`received message for unknown session from ${msg.from}`, {
        clientId: this.clientId,
        transportMessage: msg,
        ...conn.loggingMetadata,
        tags: ['invariant-violation'],
      });
      return;
    }

    // got a msg so we know the other end is alive, reset the grace period
    session.cancelGrace();

    this.log?.debug(`received msg`, {
      clientId: this.clientId,
      transportMessage: msg,
      ...conn.loggingMetadata,
    });
    if (msg.seq !== session.nextExpectedSeq) {
      if (msg.seq < session.nextExpectedSeq) {
        this.log?.debug(
          `received duplicate msg (got seq: ${msg.seq}, wanted seq: ${session.nextExpectedSeq}), discarding`,
          {
            clientId: this.clientId,
            transportMessage: msg,
            ...conn.loggingMetadata,
          },
        );
      } else {
        const errMsg = `received out-of-order msg (got seq: ${msg.seq}, wanted seq: ${session.nextExpectedSeq})`;
        this.log?.error(`${errMsg}, marking connection as dead`, {
          clientId: this.clientId,
          transportMessage: msg,
          ...conn.loggingMetadata,
          tags: ['invariant-violation'],
        });
        this.protocolError(ProtocolError.MessageOrderingViolated, errMsg);
        session.telemetry.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'message order violated',
        });
        this.deleteSession({ session, closeHandshakingConnection: true });
      }

      return;
    }

    session.updateBookkeeping(msg.ack, msg.seq);

    // don't dispatch explicit acks
    if (!isAck(msg.controlFlags)) {
      this.eventDispatcher.dispatchEvent('message', msg);
    } else {
      this.log?.debug(`discarding msg (ack bit set)`, {
        clientId: this.clientId,
        transportMessage: msg,
        ...conn.loggingMetadata,
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

  send(to: TransportClientId, msg: PartialTransportMessage): string {
    if (this.getStatus() === 'closed') {
      const err = 'transport is closed, cant send';
      this.log?.error(err, {
        clientId: this.clientId,
        transportMessage: msg,
        tags: ['invariant-violation'],
      });

      throw new Error(err);
    }

    return this.getOrCreateSession({ to }).session.send(msg);
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
    this.status = 'closed';

    for (const session of this.sessions.values()) {
      this.deleteSession({ session, closeHandshakingConnection: true });
    }

    this.eventDispatcher.dispatchEvent('transportStatus', {
      status: this.status,
    });

    this.eventDispatcher.removeAllListeners();

    this.log?.info(`manually closed transport`, { clientId: this.clientId });
  }

  getStatus(): TransportStatus {
    return this.status;
  }
}
