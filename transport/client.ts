import { SpanStatusCode } from '@opentelemetry/api';
import { ClientHandshakeOptions } from '../router/handshake';
import {
  ControlMessageHandshakeResponseSchema,
  HandshakeErrorRetriableResponseCodes,
  OpaqueTransportMessage,
  PartialTransportMessage,
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
import { coerceErrorString } from '../util/stringify';
import { ProtocolError } from './events';
import { Value } from '@sinclair/typebox/value';
import tracer, { getPropagationContext } from '../tracing';
import { Connection } from './connection';
import { MessageMetadata } from '../logging';
import { SessionConnecting } from './sessionStateMachine/SessionConnecting';
import { SessionHandshaking } from './sessionStateMachine/SessionHandshaking';
import { SessionConnected } from './sessionStateMachine/SessionConnected';
import {
  ClientSession,
  ClientSessionStateGraph,
} from './sessionStateMachine/transitions';
import { SessionState } from './sessionStateMachine/common';
import { SessionNoConnection } from './sessionStateMachine/SessionNoConnection';
import { SessionBackingOff } from './sessionStateMachine/SessionBackingOff';

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

  private tryReconnecting(to: string) {
    if (this.reconnectOnConnectionDrop && this.getStatus() === 'open') {
      this.connect(to);
    }
  }

  send(to: string, msg: PartialTransportMessage): string {
    if (this.getStatus() === 'closed') {
      const err = 'transport is closed, cant send';
      this.log?.error(err, {
        clientId: this.clientId,
        transportMessage: msg,
        tags: ['invariant-violation'],
      });

      throw new Error(err);
    }

    let session = this.sessions.get(to);
    if (!session) {
      session = this.createUnconnectedSession(to);
    }

    return session.send(msg);
  }

  private createUnconnectedSession(to: string): SessionNoConnection {
    const session = ClientSessionStateGraph.entrypoint(
      to,
      this.clientId,
      {
        onSessionGracePeriodElapsed: () => {
          this.onSessionGracePeriodElapsed(session);
        },
      },
      this.options,
      currentProtocolVersion,
      this.log,
    );

    this.updateSession(session);
    return session;
  }

  // listeners
  protected onConnectingFailed(session: SessionConnecting<ConnType>) {
    const noConnectionSession = super.onConnectingFailed(session);
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
          onInvalidHandshake: (reason) => {
            this.log?.error(
              `invalid handshake: ${reason}`,
              handshakingSession.loggingMetadata,
            );
            this.deleteSession(session);
            this.protocolError(ProtocolError.HandshakeFailed, reason);
          },
          onHandshakeTimeout: () => {
            this.log?.error(
              `connection to ${handshakingSession.to} timed out during handshake`,
              handshakingSession.loggingMetadata,
            );
            this.onConnClosed(handshakingSession);
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
    this.deleteSession(session);
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
        validationErrors: [
          ...Value.Errors(ControlMessageHandshakeResponseSchema, msg.payload),
        ],
      });
      return;
    }

    // invariant: handshake response should be ok
    if (!msg.payload.status.ok) {
      // TODO: remove conditional check after we know code is always present
      const retriable = msg.payload.status.code
        ? Value.Check(
            HandshakeErrorRetriableResponseCodes,
            msg.payload.status.code,
          )
        : false;

      const reason = `handshake failed: ${msg.payload.status.reason}`;
      this.rejectHandshakeResponse(session, reason, {
        ...session.loggingMetadata,
        transportMessage: msg,
      });

      if (retriable) {
        this.tryReconnecting(session.to);
      } else {
        this.deleteSession(session);
        this.protocolError(ProtocolError.HandshakeFailed, reason);
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
          this.log?.warn(
            `connection to ${connectedSession.to} errored: ${errStr}`,
            connectedSession.loggingMetadata,
          );
        },
        onConnectionClosed: () => {
          this.log?.info(
            `connection to ${connectedSession.to} closed`,
            connectedSession.loggingMetadata,
          );
          this.onConnClosed(connectedSession);
        },
        onMessage: (msg) => this.handleMsg(msg),
        onInvalidMessage: (reason) => {
          this.deleteSession(connectedSession);
          this.protocolError(ProtocolError.MessageOrderingViolated, reason);
        },
      });

    this.updateSession(connectedSession);
    this.retryBudget.startRestoringBudget();
  }

  /**
   * Manually attempts to connect to a client.
   * @param to The client ID of the node to connect to.
   */
  connect(to: TransportClientId) {
    // create a new session if one does not exist
    let session = this.sessions.get(to);
    session ??= this.createUnconnectedSession(to);

    if (session.state !== SessionState.NoConnection) {
      // already trying to connect
      this.log?.debug(
        `session to ${to} has state ${session.state}, skipping connect attempt`,
        session.loggingMetadata,
      );
      return;
    }

    if (this.getStatus() !== 'open') {
      this.log?.info(
        `transport state is no longer open, cancelling attempt to connect to ${to}`,
        session.loggingMetadata,
      );
      return;
    }

    // check budget
    if (!this.retryBudget.hasBudget()) {
      const budgetConsumed = this.retryBudget.getBudgetConsumed();
      const errMsg = `tried to connect to ${to} but retry budget exceeded (more than ${budgetConsumed} attempts in the last ${this.retryBudget.totalBudgetRestoreTime}ms)`;
      this.log?.error(errMsg, session.loggingMetadata);
      this.protocolError(ProtocolError.RetriesExceeded, errMsg);
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
            const reconnectPromise = tracer.startActiveSpan(
              'connect',
              async (span) => {
                try {
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
              },
            );

            this.onBackoffFinished(backingOffSession, reconnectPromise);
          },
        },
      );

    this.updateSession(backingOffSession);
  }

  protected onBackoffFinished(
    session: SessionBackingOff,
    connPromise: Promise<ConnType>,
  ) {
    // transition to connecting
    const connectingSession =
      ClientSessionStateGraph.transition.BackingOffToConnecting(
        session,
        connPromise,
        {
          onConnectionEstablished: (conn) => {
            this.log?.debug(
              `connection to ${connectingSession.to} established`,
              connectingSession.loggingMetadata,
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

    this.updateSession(connectingSession);
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

    session.sendHandshake(requestMsg);
  }

  close() {
    this.retryBudget.close();
    super.close();
  }
}
