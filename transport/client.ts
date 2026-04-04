import { SpanStatusCode } from '@opentelemetry/api';
import { ClientHandshakeOptions } from '../router/handshake';
import {
  ControlMessageHandshakeResponseSchema,
  HandshakeErrorRetriableResponseCodes,
  OpaqueTransportMessage,
  TransportClientId,
  currentProtocolVersion,
  handshakeRequestMessage,
} from './message';
import {
  ClientTransportOptions,
  ProvidedClientTransportOptions,
  defaultClientTransportOptions,
} from './options';
import { LeakyBucketRateLimit } from './rateLimit';
import { Transport } from './transport';
import { coerceErrorString } from './stringifyError';
import { ProtocolError } from './events';
import { Value } from '@sinclair/typebox/value';
import { getPropagationContext, createSessionTelemetryInfo, createConnectionTelemetryInfo } from '../tracing';
import { Connection } from './connection';
import { Session, SessionState } from './session';
import { CodecMessageAdapter } from '../codec';
import { generateId } from './id';
import { sleep, withResolvers, call } from 'effection';
import type { Operation } from 'effection';

export abstract class ClientTransport<
  ConnType extends Connection,
> extends Transport<ConnType> {
  protected options: ClientTransportOptions;
  retryBudget: LeakyBucketRateLimit;
  reconnectOnConnectionDrop = true;
  handshakeExtensions?: ClientHandshakeOptions;

  sessions: Map<TransportClientId, Session>;

  // Grace period timers keyed by peer ID
  private graceTimers = new Map<TransportClientId, ReturnType<typeof setTimeout>>();

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

  protected abstract createNewOutgoingConnection(
    to: TransportClientId,
  ): Promise<ConnType>;

  createUnconnectedSession(to: string): Session {
    const id = `session-${generateId()}`;
    const telemetry = createSessionTelemetryInfo(
      this.tracer,
      id,
      to,
      this.clientId,
    );

    const session = new Session({
      id,
      from: this.clientId,
      to,
      seq: 0,
      ack: 0,
      seqSent: 0,
      sendBuffer: [],
      telemetry,
      options: this.options,
      protocolVersion: currentProtocolVersion,
      tracer: this.tracer,
      log: this.log,
      codec: new CodecMessageAdapter(this.options.codec),
      state: SessionState.NoConnection,
    });

    this.createSessionEntry(session);

    // Start grace period timer for the initial session
    this.startGracePeriod(session);

    return session;
  }

  private startGracePeriod(session: Session) {
    const to = session.to;
    // Clear existing timer if any
    const existing = this.graceTimers.get(to);
    if (existing) {
      clearTimeout(existing);
    }

    const graceMs = session.options.sessionDisconnectGraceMs;
    const timer = setTimeout(() => {
      this.graceTimers.delete(to);
      if (!session._isConsumed) {
        this.log?.info(
          `session to ${to} grace period elapsed, closing`,
          session.loggingMetadata,
        );
        this.deleteSession(session);
      }
    }, graceMs);
    this.graceTimers.set(to, timer);
  }

  connect(to: TransportClientId) {
    if (this.getStatus() !== 'open') {
      this.log?.info(
        `transport state is no longer open, cancelling attempt to connect to ${to}`,
      );
      return;
    }

    const session = this.sessions.get(to) ?? this.createUnconnectedSession(to);
    if (session._state !== SessionState.NoConnection) {
      this.log?.debug(
        `session to ${to} has state ${session.state}, skipping connect attempt`,
        session.loggingMetadata,
      );
      return;
    }

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

    // Launch the connection lifecycle as an Effection task
    const self = this;
    const task = this.scope.run(function* () {
      yield* self.runConnectionAttempt(session, to);
    });
    this.sessionTasks.set(to, task);
  }

  /**
   * A single connection attempt: backoff → connect → handshake → connected.
   * If the connection drops, the transport's tryReconnecting method will
   * spawn a new attempt.
   */
  private *runConnectionAttempt(
    session: Session,
    to: TransportClientId,
  ): Operation<void> {
    const backoffMs = this.retryBudget.getBackoffMs();
    this.retryBudget.consumeBudget();

    // Phase 1: Backoff
    if (backoffMs > 0) {
      session._state = SessionState.BackingOff;
      this.dispatchSessionTransition(session);

      this.log?.info(
        `attempting connection to ${to} (${backoffMs}ms backoff)`,
        session.loggingMetadata,
      );

      yield* sleep(backoffMs);
    } else {
      this.log?.info(
        `attempting connection to ${to} (0ms backoff)`,
        session.loggingMetadata,
      );
    }

    // Check if session was deleted during backoff
    if (session._isConsumed || this.getStatus() !== 'open') {
      return;
    }

    // Phase 2: Connect
    session._state = SessionState.Connecting;
    this.dispatchSessionTransition(session);

    let conn: ConnType;
    try {
      const connResult = withResolvers<ConnType>();
      const timeoutResult = withResolvers<never>();

      const timeout = setTimeout(() => {
        timeoutResult.reject(new Error('connection timeout'));
      }, session.options.connectionTimeoutMs);

      // Start connection in a traced span
      const connPromise = session.tracer.startActiveSpan(
        'connect',
        async (span) => {
          try {
            return await this.createNewOutgoingConnection(to);
          } catch (err) {
            const errStr = coerceErrorString(err);
            span.recordException(errStr);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw err;
          } finally {
            span.end();
          }
        },
      );

      connPromise.then(
        (c) => { clearTimeout(timeout); connResult.resolve(c); },
        (e) => { clearTimeout(timeout); connResult.reject(e); },
      );

      // Also resolve timeout result if connection resolves first
      connPromise.then(
        () => {},
        () => {},
      );

      // Wait for either connection or timeout
      conn = yield* call(() =>
        Promise.race([
          connPromise,
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => {
              reject(new Error('connection timeout'));
            }, session.options.connectionTimeoutMs);
            // Clean up timeout if connection resolves first
            connPromise.then(() => clearTimeout(t), () => clearTimeout(t));
          }),
        ]),
      );
    } catch (e) {
      const errStr = coerceErrorString(e);
      this.log?.error(
        `error connecting to ${to}: ${errStr}`,
        session.loggingMetadata,
      );
      session._state = SessionState.NoConnection;
      this.dispatchSessionTransition(session);

      // Best effort close if the connection eventually resolves
      // (handled by the rejected promise path above)

      this.tryReconnecting(session, to);
      return;
    }

    if (session._isConsumed || this.getStatus() !== 'open') {
      conn.close();
      return;
    }

    // Phase 3: Handshake
    session._state = SessionState.Handshaking;
    session.conn = conn;
    conn.telemetry = createConnectionTelemetryInfo(
      session.tracer,
      conn,
      session.telemetry,
    );
    this.dispatchSessionTransition(session);

    this.log?.debug(
      `connection to ${to} established`,
      {
        ...conn.loggingMetadata,
        ...session.loggingMetadata,
      },
    );

    try {
      yield* this.performHandshake(session, conn);
    } catch (e) {
      if (session._isConsumed) {
        // Session was deleted during handshake (e.g., rejection).
        // Try to reconnect with a fresh session.
        if (this.reconnectOnConnectionDrop && this.getStatus() === 'open') {
          this.connect(to);
        }
        return;
      }

      const errStr = coerceErrorString(e);
      this.log?.warn(
        `handshake to ${to} failed: ${errStr}`,
        session.loggingMetadata,
      );

      conn.close();
      session.conn = null;
      session._state = SessionState.NoConnection;
      this.dispatchSessionTransition(session);
      this.tryReconnecting(session, to);
      return;
    }

    if (session._isConsumed || this.getStatus() !== 'open') {
      return;
    }

    // Phase 4: Connected!
    session._state = SessionState.Connected;
    this.dispatchSessionTransition(session);

    const bufRes = session.sendBufferedMessages();
    if (!bufRes.ok) {
      this.log?.error(`failed to send buffered messages: ${bufRes.reason}`, session.loggingMetadata);
      this.protocolError({
        type: ProtocolError.MessageSendFailure,
        message: bufRes.reason,
      });
      this.deleteSession(session, { unhealthy: true });
      return;
    }

    this.retryBudget.startRestoringBudget();

    // Clear grace period timer on successful connection
    const graceTimer = this.graceTimers.get(to);
    if (graceTimer) {
      clearTimeout(graceTimer);
      this.graceTimers.delete(to);
    }

    this.log?.info(
      `session ${session.id} transition from Handshaking to Connected`,
      {
        ...session.loggingMetadata,
        tags: ['state-transition'],
      },
    );

    // Handle disconnect synchronously
    const onDisconnect = () => {
      if (session._isConsumed) {
        return;
      }

      session.conn = null;
      session._state = SessionState.NoConnection;
      this.dispatchSessionTransition(session);

      this.log?.info(
        `connection to ${to} closed`,
        session.loggingMetadata,
      );

      // Restart the grace period timer
      this.startGracePeriod(session);
    };

    // Run connected phase - heartbeat monitoring and message handling
    yield* this.runConnectedPhase(session, conn, false, onDisconnect);

    // After disconnect, try reconnecting
    if (!session._isConsumed) {
      this.tryReconnecting(session, to);
    }
  }

  /**
   * Perform the client-side handshake: send handshake request,
   * wait for response, validate it.
   */
  private *performHandshake(
    session: Session,
    conn: ConnType,
  ): Operation<void> {
    // Construct handshake metadata if extensions are configured
    let metadata: unknown = undefined;
    if (this.handshakeExtensions) {
      try {
        metadata = yield* call(() => this.handshakeExtensions!.construct());
      } catch (err) {
        const errStr = coerceErrorString(err);
        this.log?.error(
          `failed to construct handshake metadata for session to ${session.to}: ${errStr}`,
          session.loggingMetadata,
        );
        this.protocolError({
          type: ProtocolError.HandshakeFailed,
          message: `failed to construct handshake metadata: ${errStr}`,
        });
        this.deleteSession(session, { unhealthy: true });
        return;
      }
    }

    if (session._isConsumed) {
      return;
    }

    // Set up handshake response listener
    const { operation: handshakeOp, resolve: resolveHandshake, reject: rejectHandshake } =
      withResolvers<OpaqueTransportMessage>();

    conn.setDataListener((raw: Uint8Array) => {
      const parsedMsgRes = session.codec.fromBuffer(raw);
      if (!parsedMsgRes.ok) {
        rejectHandshake(
          new Error(`could not parse handshake message: ${parsedMsgRes.reason}`),
        );
        return;
      }
      resolveHandshake(parsedMsgRes.value);
    });

    conn.setErrorListener((err: Error) => {
      this.log?.error(
        `connection to ${session.to} errored during handshake: ${coerceErrorString(err)}`,
        session.loggingMetadata,
      );
    });

    conn.setCloseListener(() => {
      this.log?.warn(
        `connection to ${session.to} closed during handshake`,
        session.loggingMetadata,
      );
      rejectHandshake(new Error('connection closed during handshake'));
    });

    // Send handshake request
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
      return;
    }

    // Wait for handshake response with timeout
    const handshakeTimeout = setTimeout(() => {
      rejectHandshake(new Error('handshake timeout'));
    }, session.options.handshakeTimeoutMs);

    let msg: OpaqueTransportMessage;
    try {
      msg = yield* handshakeOp;
    } finally {
      clearTimeout(handshakeTimeout);
      conn.removeDataListener();
      conn.removeCloseListener();
      conn.removeErrorListener();
    }

    // Validate handshake response
    if (!Value.Check(ControlMessageHandshakeResponseSchema, msg.payload)) {
      const reason = `received invalid handshake response`;
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: reason,
      });
      this.log?.warn(reason, {
        ...session.loggingMetadata,
        transportMessage: msg,
        validationErrors: [
          ...Value.Errors(ControlMessageHandshakeResponseSchema, msg.payload),
        ],
      });
      this.deleteSession(session, { unhealthy: true });
      throw new Error(reason);
    }

    if (!msg.payload.status.ok) {
      const retriable = Value.Check(
        HandshakeErrorRetriableResponseCodes,
        msg.payload.status.code,
      );
      const reason = `handshake failed: ${msg.payload.status.reason}`;
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: reason,
      });
      this.log?.warn(reason, {
        ...session.loggingMetadata,
        transportMessage: msg,
      });
      const to = session.to;
      this.deleteSession(session, { unhealthy: true });

      if (!retriable) {
        this.protocolError({
          type: ProtocolError.HandshakeFailed,
          code: msg.payload.status.code,
          message: reason,
        });
      }

      // Throw so the caller can handle reconnection
      throw new Error(reason);
    }

    if (msg.payload.status.sessionId !== session.id) {
      const reason = `session id mismatch: expected ${session.id}, got ${msg.payload.status.sessionId}`;
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: reason,
      });
      this.log?.warn(reason, {
        ...session.loggingMetadata,
        transportMessage: msg,
      });
      this.deleteSession(session, { unhealthy: true });
      throw new Error(reason);
    }

    this.log?.info(`handshake from ${msg.from} ok`, {
      ...session.loggingMetadata,
      transportMessage: msg,
    });
  }

  /**
   * Run the connected phase: message handling and heartbeat monitoring.
   * Returns when the connection drops.
   */
  protected *runConnectedPhase(
    session: Session,
    conn: ConnType,
    isActivelyHeartbeating: boolean,
    onDisconnect?: () => void,
  ): Operation<void> {
    const { operation: disconnectOp, resolve: resolveDisconnect } =
      withResolvers<void>();

    let heartbeatMissTimeout: ReturnType<typeof setTimeout> | undefined;
    let heartbeatHandle: ReturnType<typeof setInterval> | undefined;

    const resetHeartbeatTimeout = () => {
      if (heartbeatMissTimeout) {
        clearTimeout(heartbeatMissTimeout);
      }

      const maxMisses = session.options.heartbeatsUntilDead;
      const missDuration = maxMisses * session.options.heartbeatIntervalMs;
      heartbeatMissTimeout = setTimeout(() => {
        session.log?.info(
          `closing connection to ${session.to} due to inactivity (missed ${maxMisses} heartbeats which is ${missDuration}ms)`,
          session.loggingMetadata,
        );
        session.telemetry.span.addEvent(
          'closing connection due to missing heartbeat',
        );
        conn.close();
      }, missDuration);
    };

    resetHeartbeatTimeout();

    if (isActivelyHeartbeating) {
      heartbeatHandle = setInterval(() => {
        const res = session.sendHeartbeat();
        if (!res.ok) {
          this.log?.error(`failed to send heartbeat: ${res.reason}`, session.loggingMetadata);
          this.protocolError({
            type: ProtocolError.MessageSendFailure,
            message: res.reason,
          });
          this.deleteSession(session, { unhealthy: true });
        }
      }, session.options.heartbeatIntervalMs);
    }

    conn.setDataListener((raw: Uint8Array) => {
      const parsedMsg = session.processIncomingData(
        raw,
        (reason) => {
          this.log?.error(`invalid message: ${reason}`, {
            ...session.loggingMetadata,
          });
          this.protocolError({
            type: ProtocolError.InvalidMessage,
            message: reason,
          });
          this.deleteSession(session, { unhealthy: true });
        },
        isActivelyHeartbeating,
        (reason) => {
          this.log?.error(`failed to send message: ${reason}`, session.loggingMetadata);
          this.protocolError({
            type: ProtocolError.MessageSendFailure,
            message: reason,
          });
          this.deleteSession(session, { unhealthy: true });
        },
      );

      if (parsedMsg) {
        resetHeartbeatTimeout();
        this.handleMsg(parsedMsg);
      } else if (session.ack > 0) {
        resetHeartbeatTimeout();
      }
    });

    conn.setErrorListener((err: Error) => {
      const errStr = coerceErrorString(err);
      if (
        err instanceof Error &&
        this.options.isFatalConnectionError(err)
      ) {
        this.log?.warn(
          `connection to ${session.to} fatally errored: ${errStr}`,
          session.loggingMetadata,
        );
        this.reconnectOnConnectionDrop = false;
      } else {
        this.log?.warn(
          `connection to ${session.to} errored: ${errStr}`,
          session.loggingMetadata,
        );
      }
    });

    conn.setCloseListener(() => {
      // Clean up synchronously on close
      conn.removeDataListener();
      conn.removeCloseListener();
      conn.removeErrorListener();

      if (heartbeatMissTimeout) {
        clearTimeout(heartbeatMissTimeout);
        heartbeatMissTimeout = undefined;
      }

      if (heartbeatHandle) {
        clearInterval(heartbeatHandle);
        heartbeatHandle = undefined;
      }

      onDisconnect?.();
      resolveDisconnect();
    });

    yield* disconnectOp;
  }

  private tryReconnecting(session: Session, to: TransportClientId) {
    // Clean up the old task handle
    this.sessionTasks.delete(to);

    if (session._isConsumed) {
      return;
    }

    if (!this.options.enableTransparentSessionReconnects) {
      this.deleteSession(session);
      return;
    }

    if (this.reconnectOnConnectionDrop && this.getStatus() === 'open') {
      this.connect(to);
    }
    // Grace period timer is started in the onDisconnect handler,
    // so it's already running whether we reconnect or not.
  }

  hardDisconnect() {
    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
      this.deleteSession(session);
    }
  }

  close() {
    this.retryBudget.close();
    // Clear all grace period timers
    for (const timer of this.graceTimers.values()) {
      clearTimeout(timer);
    }
    this.graceTimers.clear();
    super.close();
  }
}
