import { SpanStatusCode } from '@opentelemetry/api';
import { ClientHandshakeOptions } from '../router/handshake';
import {
  ControlMessageHandshakeResponseSchema,
  OpaqueTransportMessage,
  PartialTransportMessage,
  TransportClientId,
  handshakeRequestMessage,
} from './message';
import {
  ClientTransportOptions,
  ProvidedClientTransportOptions,
  defaultClientTransportOptions,
} from './options';
import { LeakyBucketRateLimit } from './rateLimit';
import { Transport } from './transport';
import { coerceErrorString } from '../util/stringify';
import { ProtocolError } from './events';
import { Value } from '@sinclair/typebox/value';
import tracer, { getPropagationContext } from '../tracing';
import { Connection } from './connection';
import {
  Session,
  SessionConnected,
  SessionConnecting,
  SessionHandshaking,
  SessionNoConnection,
  SessionState,
  SessionStateMachine,
} from './sessionStateMachine';

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

  constructor(
    clientId: TransportClientId,
    providedOptions?: ProvidedClientTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.options = {
      ...defaultClientTransportOptions,
      ...providedOptions,
    };
    this.retryBudget = new LeakyBucketRateLimit(this.options);
  }

  extendHandshake(options: ClientHandshakeOptions) {
    this.handshakeExtensions = options;
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

  // listeners
  private onSessionGracePeriodElapsed = (session: SessionNoConnection) => {
    this.log?.warn(
      `session to ${session.to} grace period elapsed, closing`,
      session.loggingMetadata,
    );
    this.deleteSession(session);
  };

  private onConnectionEstablished = (
    session: SessionConnecting<ConnType>,
    conn: ConnType,
  ) => {
    // transition to handshaking
    const handshakingSession =
      SessionStateMachine.transition.ConnectingToHandshaking(session, conn, {
        onConnectionErrored: (err) => {
          // just log, when we error we also emit close
          const errStr = coerceErrorString(err);
          this.log?.error(
            `connection to ${session.to} errored during handshake: ${errStr}`,
            handshakingSession.loggingMetadata,
          );
        },
        onConnectionClosed: () => {
          this.log?.error(
            `connection to ${session.to} closed during handshake`,
            handshakingSession.loggingMetadata,
          );
          this.onConnClosed(handshakingSession);
        },
        onHandshake: (msg) => {
          this.onHandshakeResponse(handshakingSession, msg);
        },
        onHandshakeTimeout: () => {
          this.log?.error(
            `connection to ${session.to} timed out during handshake`,
            handshakingSession.loggingMetadata,
          );
          this.onConnClosed(handshakingSession);
        },
      });

    this.session = handshakingSession;

    // send the handshake
    void this.sendHandshake(handshakingSession);
  };

  private onHandshakeResponse = (
    session: SessionHandshaking<ConnType>,
    msg: OpaqueTransportMessage,
  ) => {
    // invariant: msg is a handshake response
    if (!Value.Check(ControlMessageHandshakeResponseSchema, msg.payload)) {
      session.conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'invalid handshake response',
      });
      this.log?.warn(`received invalid handshake resp`, {
        ...session.loggingMetadata,
        transportMessage: msg,
        validationErrors: [
          ...Value.Errors(ControlMessageHandshakeResponseSchema, msg.payload),
        ],
      });
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'invalid handshake resp',
      );
      this.destroySession(session);
      return;
    }

    // invariant: handshake response should be ok
    if (!msg.payload.status.ok) {
      const reason = `handshake failed: ${msg.payload.status.reason}`;
      session.conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: reason,
      });
      this.log?.warn(reason, {
        ...session.loggingMetadata,
        transportMessage: msg,
      });
      this.protocolError(ProtocolError.HandshakeFailed, reason);
      this.destroySession(session);
      return;
    }

    // invariant: session id should match between client + server
    if (msg.payload.status.sessionId !== session.id) {
      const reason = `session id mismatch: expected ${session.id}, got ${msg.payload.status.sessionId}`;
      session.conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: reason,
      });
      this.log?.warn(reason, {
        ...session.loggingMetadata,
        transportMessage: msg,
      });
      this.protocolError(ProtocolError.HandshakeFailed, reason);
      this.destroySession(session);
      return;
    }

    // transition to connected!
    this.log?.debug(`handshake from ${msg.from} ok`, {
      ...session.loggingMetadata,
      transportMessage: msg,
    });

    const connectedSession =
      SessionStateMachine.transition.HandshakingToConnected(session, {
        onConnectionErrored: (err) => {
          // just log, when we error we also emit close
          const errStr = coerceErrorString(err);
          this.log?.error(
            `connection to ${session.to} errored: ${errStr}`,
            connectedSession.loggingMetadata,
          );
        },
        onConnectionClosed: () => {
          this.log?.error(
            `connection to ${session.to} closed`,
            connectedSession.loggingMetadata,
          );
          this.onConnClosed(connectedSession);
        },
        onMessage: (msg) => this.handleMsg(msg),
      });

    this.session = connectedSession;
    this.retryBudget.startRestoringBudget(session.to);
  };

  private tryReconnecting(to: string) {
    if (this.reconnectOnConnectionDrop && this.getStatus() === 'open') {
      this.connect(to);
    }
  }

  private onConnectingFailed = (session: SessionConnecting<ConnType>) => {
    // transition to no connection
    const noConnectionSession =
      SessionStateMachine.transition.ConnectingToNoConnection(session, {
        onSessionGracePeriodElapsed: () => {
          this.onSessionGracePeriodElapsed(noConnectionSession);
        },
      });

    this.session = noConnectionSession;
    this.tryReconnecting(noConnectionSession.to);
  };

  private onConnClosed = (
    session: SessionHandshaking<ConnType> | SessionConnected<ConnType>,
  ) => {
    // transition to no connection
    let noConnectionSession: SessionNoConnection;
    if (session.state === SessionState.Handshaking) {
      noConnectionSession =
        SessionStateMachine.transition.HandshakingToNoConnection(session, {
          onSessionGracePeriodElapsed: () => {
            this.onSessionGracePeriodElapsed(noConnectionSession);
          },
        });
    } else {
      noConnectionSession =
        SessionStateMachine.transition.ConnectedToNoConnection(session, {
          onSessionGracePeriodElapsed: () => {
            this.onSessionGracePeriodElapsed(noConnectionSession);
          },
        });
    }

    this.session = noConnectionSession;
    this.tryReconnecting(noConnectionSession.to);
  };

  /**
   * Manually attempts to connect to a client.
   * @param to The client ID of the node to connect to.
   */
  connect(to: TransportClientId) {
    // create a new session if one does not exist
    if (!this.session) {
      this.session = this.createSession(to);
    }

    if (this.session.state !== SessionState.NoConnection) {
      // already trying to connect
      this.log?.debug(
        `session to ${to} has state ${this.session.state}, skipping connect attempt`,
        this.session.loggingMetadata,
      );
      return;
    }

    if (this.getStatus() !== 'open') {
      this.log?.info(
        `transport state is no longer open, cancelling attempt to connect to ${to}`,
        this.session.loggingMetadata,
      );
      return;
    }

    // check budget
    if (!this.retryBudget.hasBudget(to)) {
      const budgetConsumed = this.retryBudget.getBudgetConsumed(to);
      const errMsg = `tried to connect to ${to} but retry budget exceeded (more than ${budgetConsumed} attempts in the last ${this.retryBudget.totalBudgetRestoreTime}ms)`;
      this.log?.error(errMsg, this.session.loggingMetadata);
      this.protocolError(ProtocolError.RetriesExceeded, errMsg);
      return;
    }

    let sleep = Promise.resolve();
    const backoffMs = this.retryBudget.getBackoffMs(to);
    if (backoffMs > 0) {
      sleep = new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    this.log?.info(
      `attempting connection to ${to} (${backoffMs}ms backoff)`,
      this.session.loggingMetadata,
    );

    this.retryBudget.consumeBudget(to);
    const reconnectPromise = tracer.startActiveSpan('connect', async (span) => {
      try {
        span.addEvent('backoff', { backoffMs });
        await sleep;
        if (this.getStatus() !== 'open') {
          throw new Error('transport state is no longer open');
        }

        span.addEvent('connecting');
        return await this.createNewOutgoingConnection(to);
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

    const connectingSession =
      SessionStateMachine.transition.NoConnectionToConnecting(
        this.session,
        reconnectPromise,
        {
          onConnectionEstablished: (conn: ConnType) => {
            this.log?.debug(
              `connection to ${to} established`,
              connectingSession.loggingMetadata,
            );
            this.onConnectionEstablished(connectingSession, conn);
          },
          onConnectionFailed: (error: unknown) => {
            const errStr = coerceErrorString(error);
            this.log?.error(
              `error connecting to ${connectingSession.to}: ${errStr}`,
              connectingSession.loggingMetadata,
            );
            this.onConnectingFailed(connectingSession);
          },
          onConnectionTimeout: () => {
            this.log?.error(
              `connection to ${connectingSession.to} timed out`,
              connectingSession.loggingMetadata,
            );
            this.onConnectingFailed(connectingSession);
          },
        },
      );

    this.session = connectingSession;
  }

  private async sendHandshake(session: SessionHandshaking<ConnType>) {
    let metadata: unknown = undefined;

    if (this.handshakeExtensions) {
      metadata = await this.handshakeExtensions.construct();
    }

    const requestMsg = handshakeRequestMessage({
      from: this.clientId,
      to: session.to,
      sessionId: session.id,
      expectedSessionState: {
        reconnect: session.ack > 0,
        nextExpectedSeq: session.ack,
      },
      metadata,
      tracing: getPropagationContext(session.telemetry.ctx),
    });

    this.log?.debug(`sending handshake request to ${session.to}`, {
      ...session.loggingMetadata,
      transportMessage: requestMsg,
    });

    session.sendHandshake(requestMsg);
  }

  close() {
    this.retryBudget.close();
    super.close();
  }
}
