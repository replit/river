import { SpanStatusCode } from '@opentelemetry/api';
import { ClientHandshakeOptions } from '../router/handshake';
import { validationErrorToRiverErrors } from '../router/errors';
import {
  ControlMessageHandshakeResponseSchema,
  ControlMessageRehandshakeRequestSchema,
  HandshakeErrorRetriableResponseCodes,
  OpaqueTransportMessage,
  TransportClientId,
  currentProtocolVersion,
  handshakeRequestMessage,
  rehandshakeResponseMessage,
} from './message';
import {
  ClientTransportOptions,
  ProvidedClientTransportOptions,
  defaultClientTransportOptions,
} from './options';
import { LeakyBucketRateLimit } from './rateLimit';
import { DeleteSessionOptions, Transport } from './transport';
import { coerceErrorString } from './stringifyError';
import { ProtocolError } from './events';
import { Value } from 'typebox/value';
import { getPropagationContext } from '../tracing';
import { Connection } from './connection';
import { MessageMetadata } from '../logging';
import { SessionConnecting } from './sessionStateMachine/SessionConnecting';
import { SessionHandshaking } from './sessionStateMachine/SessionHandshaking';
import { SessionConnected } from './sessionStateMachine/SessionConnected';
import {
  ClientSession,
  ClientSessionStateGraph,
  Session,
} from './sessionStateMachine/transitions';
import { SessionState } from './sessionStateMachine/common';
import { SessionNoConnection } from './sessionStateMachine/SessionNoConnection';
import { SessionBackingOff } from './sessionStateMachine/SessionBackingOff';

/**
 * Outcome of constructing client handshake metadata, kept as a value (rather than a
 * rejecting promise) so it can be prefetched when a connection attempt starts and
 * awaited later even if that attempt is abandoned before the handshake is sent.
 */
type ConstructedHandshakeMetadata =
  | {
      ok: true;
      metadata: Awaited<ReturnType<ClientHandshakeOptions['construct']>>;
    }
  | { ok: false; reason: string };

export abstract class ClientTransport<
  ConnType extends Connection,
> extends Transport<ConnType> {
  /**
   * The options for this transport.
   */
  protected options: ClientTransportOptions;

  retryBudget: LeakyBucketRateLimit;

  /**
   * A flag indicating whether the transport should automatically reconnect
   * when a connection is dropped.
   * Realistically, this should always be true for clients unless you are writing
   * tests or a special case where you don't want to reconnect.
   */
  reconnectOnConnectionDrop = true;

  /**
   * Optional handshake options for this client.
   */
  handshakeExtensions?: ClientHandshakeOptions;

  /**
   * Handshake-metadata constructions prefetched when a connection attempt begins
   * (only when {@link ClientHandshakeOptions.eager} is set), so the
   * token fetch overlaps the dial instead of following it. Keyed by the peer being
   * connected to; consumed when the handshake is sent and cleared when an attempt
   * is abandoned.
   */
  private pendingHandshakeMetadata = new Map<
    TransportClientId,
    Promise<ConstructedHandshakeMetadata>
  >();

  sessions: Map<TransportClientId, ClientSession<ConnType>>;

  constructor(
    clientId: TransportClientId,
    providedOptions?: ProvidedClientTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.sessions = new Map();
    this.options = {
      ...defaultClientTransportOptions,
      ...providedOptions,
    };
    this.retryBudget = new LeakyBucketRateLimit(this.options);
  }

  extendHandshake(options: ClientHandshakeOptions) {
    this.handshakeExtensions = options;
  }

  protected handleRehandshakeMessage(message: OpaqueTransportMessage): void {
    if (!Value.Check(ControlMessageRehandshakeRequestSchema, message.payload)) {
      this.log?.warn(
        `ignoring malformed re-handshake request from ${message.from}`,
        { clientId: this.clientId, connectedTo: message.from },
      );

      return;
    }

    void this.sendRehandshake(message.from);
  }

  /**
   * Re-constructs handshake metadata via the configured handshake extension and
   * sends it back to the server so it can replace the metadata for this session.
   * Triggered by a server {@link ControlMessageRehandshakeRequestSchema}.
   */
  private async sendRehandshake(to: TransportClientId) {
    if (!this.handshakeExtensions) {
      this.log?.warn(
        `got re-handshake request from ${to} but no handshake extensions are configured, ignoring`,
        { clientId: this.clientId, connectedTo: to },
      );

      return;
    }

    const session = this.sessions.get(to);
    if (!session || session.state !== SessionState.Connected) {
      return;
    }

    const loggingMetadata = session.loggingMetadata;
    const sessionId = session.id;

    let metadata: unknown;
    try {
      metadata = await this.handshakeExtensions.construct();
    } catch (err) {
      this.log?.error(
        `failed to construct re-handshake metadata for ${to}: ${coerceErrorString(
          err,
        )}`,
        loggingMetadata,
      );

      return;
    }

    // bind the send to the session that asked to re-handshake: a hard reconnect
    // during construct() makes the send throw rather than delivering stale
    // metadata to the freshly handshaked session that replaced it
    try {
      const send = this.getSessionBoundSendFn(to, sessionId);
      send(rehandshakeResponseMessage(metadata));
    } catch (err) {
      const reason = coerceErrorString(err);
      this.log?.error(
        `failed to send re-handshake metadata to ${to}: ${reason}`,
        loggingMetadata,
      );
      this.protocolError({
        type: ProtocolError.MessageSendFailure,
        message: reason,
      });
    }
  }

  /**
   * Abstract method that creates a new {@link Connection} object.
   *
   * @param to The client ID of the node to connect to.
   * @returns The new connection object.
   */
  protected abstract createNewOutgoingConnection(
    to: TransportClientId,
  ): Promise<ConnType>;

  private tryReconnecting(to: TransportClientId) {
    const oldSession = this.sessions.get(to);
    if (!this.options.enableTransparentSessionReconnects && oldSession) {
      this.deleteSession(oldSession);
    }

    if (this.reconnectOnConnectionDrop && this.getStatus() === 'open') {
      this.connect(to);
    }
  }

  /*
   * Creates a raw unconnected session object.
   * This is mostly a River internal, you shouldn't need to use this directly.
   */
  createUnconnectedSession(to: string): SessionNoConnection {
    const session = ClientSessionStateGraph.entrypoint(
      to,
      this.clientId,
      {
        onSessionGracePeriodElapsed: () => {
          this.onSessionGracePeriodElapsed(session);
        },
        onMessageSendFailure: (msg, reason) => {
          this.log?.error(`failed to send message: ${reason}`, {
            ...session.loggingMetadata,
            transportMessage: msg,
          });

          this.protocolError({
            type: ProtocolError.MessageSendFailure,
            message: reason,
          });
          this.deleteSession(session, { unhealthy: true });
        },
      },
      this.options,
      currentProtocolVersion,
      this.tracer,
      this.log,
    );

    this.createSession(session);

    return session;
  }

  protected deleteSession(
    session: Session<ConnType>,
    options?: DeleteSessionOptions,
  ): void {
    // drop any handshake metadata prefetched for an attempt that's being torn down
    this.pendingHandshakeMetadata.delete(session.to);
    super.deleteSession(session, options);
  }

  // listeners
  protected onConnectingFailed(
    session: SessionConnecting<ConnType>,
    error?: unknown,
  ) {
    const noConnectionSession = super.onConnectingFailed(session);

    if (error instanceof Error && this.options.isFatalConnectionError(error)) {
      this.reconnectOnConnectionDrop = false;
      this.deleteSession(noConnectionSession, { unhealthy: true });

      return noConnectionSession;
    }

    this.tryReconnecting(noConnectionSession.to);

    return noConnectionSession;
  }

  protected onConnClosed(
    session: SessionHandshaking<ConnType> | SessionConnected<ConnType>,
  ) {
    const noConnectionSession = super.onConnClosed(session);
    this.tryReconnecting(noConnectionSession.to);

    return noConnectionSession;
  }

  protected onConnectionEstablished(
    session: SessionConnecting<ConnType>,
    conn: ConnType,
  ): SessionHandshaking<ConnType> {
    // transition to handshaking
    const handshakingSession =
      ClientSessionStateGraph.transition.ConnectingToHandshaking(
        session,
        conn,
        {
          onConnectionErrored: (err) => {
            // just log, when we error we also emit close
            const errStr = coerceErrorString(err);
            this.log?.error(
              `connection to ${handshakingSession.to} errored during handshake: ${errStr}`,
              handshakingSession.loggingMetadata,
            );
          },
          onConnectionClosed: () => {
            this.log?.warn(
              `connection to ${handshakingSession.to} closed during handshake`,
              handshakingSession.loggingMetadata,
            );
            this.onConnClosed(handshakingSession);
          },
          onHandshake: (msg) => {
            this.onHandshakeResponse(handshakingSession, msg);
          },
          onInvalidHandshake: (reason, code) => {
            this.log?.error(
              `invalid handshake: ${reason}`,
              handshakingSession.loggingMetadata,
            );
            this.deleteSession(session, { unhealthy: true });
            this.protocolError({
              type: ProtocolError.HandshakeFailed,
              code,
              message: reason,
            });
          },
          onHandshakeTimeout: () => {
            this.log?.error(
              `connection to ${handshakingSession.to} timed out during handshake`,
              handshakingSession.loggingMetadata,
            );
            this.onConnClosed(handshakingSession);
          },
          onSessionGracePeriodElapsed: () => {
            this.onSessionGracePeriodElapsed(handshakingSession);
          },
          onMessageSendFailure: (msg, reason) => {
            this.log?.error(`failed to send message: ${reason}`, {
              ...handshakingSession.loggingMetadata,
              transportMessage: msg,
            });

            this.protocolError({
              type: ProtocolError.MessageSendFailure,
              message: reason,
            });
            this.deleteSession(handshakingSession, { unhealthy: true });
          },
        },
      );

    this.updateSession(handshakingSession);
    void this.sendHandshake(handshakingSession);

    return handshakingSession;
  }

  private rejectHandshakeResponse(
    session: SessionHandshaking<ConnType>,
    reason: string,
    metadata: MessageMetadata,
  ) {
    session.conn.telemetry?.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: reason,
    });

    this.log?.warn(reason, metadata);
    this.deleteSession(session, { unhealthy: true });
  }

  protected onHandshakeResponse(
    session: SessionHandshaking<ConnType>,
    msg: OpaqueTransportMessage,
  ) {
    // invariant: msg is a handshake response
    if (!Value.Check(ControlMessageHandshakeResponseSchema, msg.payload)) {
      const reason = `received invalid handshake response`;
      this.rejectHandshakeResponse(session, reason, {
        ...session.loggingMetadata,
        transportMessage: msg,
        validationErrors: Value.Errors(
          ControlMessageHandshakeResponseSchema,
          msg.payload,
        ).flatMap(validationErrorToRiverErrors),
      });

      return;
    }

    // invariant: handshake response should be ok
    if (!msg.payload.status.ok) {
      const retriable = Value.Check(
        HandshakeErrorRetriableResponseCodes,
        msg.payload.status.code,
      );

      const reason = `handshake failed: ${msg.payload.status.reason}`;
      const to = session.to;
      this.rejectHandshakeResponse(session, reason, {
        ...session.loggingMetadata,
        transportMessage: msg,
      });

      if (retriable) {
        this.tryReconnecting(to);
      } else {
        this.protocolError({
          type: ProtocolError.HandshakeFailed,
          code: msg.payload.status.code,
          message: reason,
        });
      }

      return;
    }

    // invariant: session id should match between client + server
    if (msg.payload.status.sessionId !== session.id) {
      const reason = `session id mismatch: expected ${session.id}, got ${msg.payload.status.sessionId}`;
      this.rejectHandshakeResponse(session, reason, {
        ...session.loggingMetadata,
        transportMessage: msg,
      });

      return;
    }

    // transition to connected!
    this.log?.info(`handshake from ${msg.from} ok`, {
      ...session.loggingMetadata,
      transportMessage: msg,
    });

    const connectedSession =
      ClientSessionStateGraph.transition.HandshakingToConnected(session, {
        onConnectionErrored: (err) => {
          // just log, when we error we also emit close
          const errStr = coerceErrorString(err);

          if (
            err instanceof Error &&
            this.options.isFatalConnectionError(err)
          ) {
            this.log?.warn(
              `connection to ${connectedSession.to} fatally errored: ${errStr}`,
              connectedSession.loggingMetadata,
            );

            this.reconnectOnConnectionDrop = false;
          } else {
            this.log?.warn(
              `connection to ${connectedSession.to} errored: ${errStr}`,
              connectedSession.loggingMetadata,
            );
          }
        },
        onConnectionClosed: () => {
          this.log?.info(
            `connection to ${connectedSession.to} closed`,
            connectedSession.loggingMetadata,
          );
          this.onConnClosed(connectedSession);
        },
        onMessage: (msg) => {
          this.handleMsg(msg);
        },
        onRehandshake: (msg) => {
          this.handleRehandshakeMessage(msg);
        },
        onInvalidMessage: (reason) => {
          this.log?.error(`invalid message: ${reason}`, {
            ...connectedSession.loggingMetadata,
            transportMessage: msg,
          });

          this.protocolError({
            type: ProtocolError.InvalidMessage,
            message: reason,
          });
          this.deleteSession(connectedSession, { unhealthy: true });
        },
        onMessageSendFailure: (msg, reason) => {
          this.log?.error(`failed to send message: ${reason}`, {
            ...connectedSession.loggingMetadata,
            transportMessage: msg,
          });

          this.protocolError({
            type: ProtocolError.MessageSendFailure,
            message: reason,
          });
          this.deleteSession(connectedSession, { unhealthy: true });
        },
      });

    const res = connectedSession.sendBufferedMessages();
    if (!res.ok) {
      return;
    }

    this.updateSession(connectedSession);
    this.retryBudget.startRestoringBudget();
  }

  /**
   * Manually attempts to connect to a client.
   * @param to The client ID of the node to connect to.
   */
  connect(to: TransportClientId) {
    if (this.getStatus() !== 'open') {
      this.log?.info(
        `transport state is no longer open, cancelling attempt to connect to ${to}`,
      );

      return;
    }

    const session = this.sessions.get(to) ?? this.createUnconnectedSession(to);
    if (session.state !== SessionState.NoConnection) {
      // already trying to connect
      this.log?.debug(
        `session to ${to} has state ${session.state}, skipping connect attempt`,
        session.loggingMetadata,
      );

      return;
    }

    // check budget
    if (!this.retryBudget.hasBudget()) {
      const budgetConsumed = this.retryBudget.getBudgetConsumed();
      const errMsg = `tried to connect to ${to} but retry budget exceeded (more than ${budgetConsumed} attempts in the last ${this.retryBudget.totalBudgetRestoreTime}ms)`;
      this.log?.error(errMsg, session.loggingMetadata);
      this.protocolError({
        type: ProtocolError.RetriesExceeded,
        message: errMsg,
      });

      return;
    }

    const backoffMs = this.retryBudget.getBackoffMs();

    this.log?.info(
      `attempting connection to ${to} (${backoffMs}ms backoff)`,
      session.loggingMetadata,
    );

    this.retryBudget.consumeBudget();
    const backingOffSession =
      ClientSessionStateGraph.transition.NoConnectionToBackingOff(
        session,
        backoffMs,
        {
          onBackoffFinished: () => {
            this.onBackoffFinished(backingOffSession);
          },
          onSessionGracePeriodElapsed: () => {
            this.onSessionGracePeriodElapsed(backingOffSession);
          },
          onMessageSendFailure: (msg, reason) => {
            this.log?.error(`failed to send message: ${reason}`, {
              ...backingOffSession.loggingMetadata,
              transportMessage: msg,
            });

            this.protocolError({
              type: ProtocolError.MessageSendFailure,
              message: reason,
            });
            this.deleteSession(backingOffSession, { unhealthy: true });
          },
        },
      );

    this.updateSession(backingOffSession);
  }

  /**
   * Manually kills all sessions to the server (including all pending state).
   * This is useful for when you want to close all connections to a server
   * and don't want to wait for the grace period to elapse.
   */
  hardDisconnect() {
    // create a copy of the sessions to avoid modifying the map while iterating
    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
      this.deleteSession(session);
    }
  }

  protected onBackoffFinished(session: SessionBackingOff) {
    const connPromise = session.tracer.startActiveSpan(
      'connect',
      async (span) => {
        try {
          return await this.createNewOutgoingConnection(session.to);
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
      },
    );

    // when opted in, kick off the handshake-metadata construction now so a slow
    // token fetch overlaps establishing the connection instead of running after it
    if (this.handshakeExtensions?.eager) {
      this.pendingHandshakeMetadata.set(
        session.to,
        this.constructHandshakeMetadata(),
      );
    }

    // transition to connecting
    const connectingSession =
      ClientSessionStateGraph.transition.BackingOffToConnecting(
        session,
        connPromise,
        {
          onConnectionEstablished: (conn) => {
            this.log?.debug(
              `connection to ${connectingSession.to} established`,
              {
                ...conn.loggingMetadata,
                ...connectingSession.loggingMetadata,
              },
            );

            // cast here because conn can't be narrowed to ConnType
            // in the callback due to variance rules
            this.onConnectionEstablished(connectingSession, conn as ConnType);
          },
          onConnectionFailed: (error: unknown) => {
            const errStr = coerceErrorString(error);
            this.log?.error(
              `error connecting to ${connectingSession.to}: ${errStr}`,
              connectingSession.loggingMetadata,
            );
            this.onConnectingFailed(connectingSession, error);
          },
          onConnectionTimeout: () => {
            this.log?.error(
              `connection to ${connectingSession.to} timed out`,
              connectingSession.loggingMetadata,
            );
            this.onConnectingFailed(connectingSession);
          },
          onSessionGracePeriodElapsed: () => {
            this.onSessionGracePeriodElapsed(connectingSession);
          },
          onMessageSendFailure: (msg, reason) => {
            this.log?.error(`failed to send message: ${reason}`, {
              ...connectingSession.loggingMetadata,
              transportMessage: msg,
            });

            this.protocolError({
              type: ProtocolError.MessageSendFailure,
              message: reason,
            });
            this.deleteSession(connectingSession, { unhealthy: true });
          },
        },
      );

    this.updateSession(connectingSession);
  }

  /**
   * Constructs handshake metadata via the configured handshake extension, capturing
   * a failure as a value so a prefetched result can be awaited without rejecting.
   */
  private async constructHandshakeMetadata(): Promise<ConstructedHandshakeMetadata> {
    if (!this.handshakeExtensions) {
      return { ok: true, metadata: undefined };
    }

    try {
      return { ok: true, metadata: await this.handshakeExtensions.construct() };
    } catch (err) {
      return { ok: false, reason: coerceErrorString(err) };
    }
  }

  private async sendHandshake(session: SessionHandshaking<ConnType>) {
    let metadata: unknown = undefined;

    if (this.handshakeExtensions) {
      // consume the metadata prefetched when the connection attempt began, falling
      // back to constructing now if none is in flight (e.g. a direct transition)
      const pending = this.pendingHandshakeMetadata.get(session.to);
      this.pendingHandshakeMetadata.delete(session.to);
      const result = await (pending ?? this.constructHandshakeMetadata());

      if (!result.ok) {
        this.log?.error(
          `failed to construct handshake metadata for session to ${session.to}: ${result.reason}`,
          session.loggingMetadata,
        );

        this.protocolError({
          type: ProtocolError.HandshakeFailed,
          message: `failed to construct handshake metadata: ${result.reason}`,
        });
        this.deleteSession(session, { unhealthy: true });

        return;
      }

      metadata = result.metadata;
    }

    // double-check to make sure we haven't transitioned the session yet
    if (session._isConsumed) {
      // bail out, don't need to do anything
      return;
    }

    const requestMsg = handshakeRequestMessage({
      from: this.clientId,
      to: session.to,
      sessionId: session.id,
      expectedSessionState: {
        nextExpectedSeq: session.ack,
        nextSentSeq: session.nextSeq(),
      },
      metadata,
      tracing: getPropagationContext(session.telemetry.ctx),
    });

    this.log?.debug(`sending handshake request to ${session.to}`, {
      ...session.loggingMetadata,
      transportMessage: requestMsg,
    });

    const res = session.sendHandshake(requestMsg);
    if (!res.ok) {
      this.log?.error(`failed to send handshake request: ${res.reason}`, {
        ...session.loggingMetadata,
        transportMessage: requestMsg,
      });

      this.protocolError({
        type: ProtocolError.MessageSendFailure,
        message: res.reason,
      });
      this.deleteSession(session, { unhealthy: true });
    }
  }

  close() {
    this.retryBudget.close();
    super.close();
  }
}
