import { SpanStatusCode } from '@opentelemetry/api';
import { ClientHandshakeOptions } from '../router/handshake';
import {
  ControlMessageHandshakeResponseSchema,
  SESSION_STATE_MISMATCH,
  TransportClientId,
  handshakeRequestMessage,
} from './message';
import {
  ClientTransportOptions,
  ProvidedClientTransportOptions,
  defaultClientTransportOptions,
} from './options';
import { LeakyBucketRateLimit } from './rateLimit';
import { Connection, Session } from './session';
import { Transport } from './transport';
import { coerceErrorString } from '../util/stringify';
import { ProtocolError } from './events';
import { Value } from '@sinclair/typebox/value';
import tracer, { getPropagationContext } from '../tracing';

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
    this.inflightConnectionPromises = new Map();
    this.retryBudget = new LeakyBucketRateLimit(this.options);
  }

  extendHandshake(options: ClientHandshakeOptions) {
    this.handshakeExtensions = options;
  }

  protected handleConnection(conn: ConnType, to: TransportClientId): void {
    if (this.getStatus() !== 'open') return;
    let session: Session<ConnType> | undefined = undefined;

    // kill the conn after the grace period if we haven't received a handshake
    const handshakeTimeout = setTimeout(() => {
      if (session) return;
      this.log?.warn(
        `connection to ${to} timed out waiting for handshake, closing`,
        { ...conn.loggingMetadata, clientId: this.clientId, connectedTo: to },
      );
      conn.close();
    }, this.options.sessionDisconnectGraceMs);

    const handshakeHandler = (data: Uint8Array) => {
      const maybeSession = this.receiveHandshakeResponseMessage(data, conn);
      clearTimeout(handshakeTimeout);
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
        const parsed = this.parseMsg(data, conn);
        if (!parsed) {
          conn.telemetry?.span.setStatus({
            code: SpanStatusCode.ERROR,
            message: 'message parse failure',
          });
          conn.close();
          return;
        }

        this.handleMsg(parsed, conn);
      });
    };

    conn.addDataListener(handshakeHandler);
    conn.addCloseListener(() => {
      if (session) {
        this.onDisconnect(conn, session);
      }

      const willReconnect =
        this.reconnectOnConnectionDrop && this.getStatus() === 'open';

      this.log?.info(
        `connection to ${to} disconnected` +
          (willReconnect ? ', reconnecting' : ''),
        {
          ...conn.loggingMetadata,
          ...session?.loggingMetadata,
          clientId: this.clientId,
          connectedTo: to,
        },
      );

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
      this.log?.warn(
        `error in connection to ${to}: ${coerceErrorString(err)}`,
        {
          ...conn.loggingMetadata,
          ...session?.loggingMetadata,
          clientId: this.clientId,
          connectedTo: to,
        },
      );
    });
  }

  receiveHandshakeResponseMessage(
    data: Uint8Array,
    conn: ConnType,
  ): Session<ConnType> | false {
    const parsed = this.parseMsg(data, conn);
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
      this.log?.warn(`received invalid handshake resp`, {
        ...conn.loggingMetadata,
        clientId: this.clientId,
        connectedTo: parsed.from,
        transportMessage: parsed,
        validationErrors: [
          ...Value.Errors(
            ControlMessageHandshakeResponseSchema,
            parsed.payload,
          ),
        ],
      });
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'invalid handshake resp',
      );
      return false;
    }

    const previousSession = this.sessions.get(parsed.from);
    if (!parsed.payload.status.ok) {
      if (parsed.payload.status.reason === SESSION_STATE_MISMATCH) {
        if (previousSession) {
          // The server has told us that we cannot continue with the session because it has the
          // wrong state. We should delete this session and start fresh.
          this.deleteSession({
            session: previousSession,
            closeHandshakingConnection: true,
          });
        }

        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: parsed.payload.status.reason,
        });
      } else {
        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'handshake rejected',
        });
      }
      this.log?.warn(
        `received handshake rejection: ${parsed.payload.status.reason}`,
        {
          ...conn.loggingMetadata,
          clientId: this.clientId,
          connectedTo: parsed.from,
          transportMessage: parsed,
        },
      );
      this.protocolError(
        ProtocolError.HandshakeFailed,
        parsed.payload.status.reason,
      );
      return false;
    }

    // before we claim victory and we deem that the handshake is fully established, check that our
    // session matches the remote's. if they do not match, proactively close the connection.
    // otherwise we will end up breaking a lot of invariants.
    //
    // TODO: Remove this once we finish rolling out the handshake-initiated session agreement.
    if (
      previousSession?.advertisedSessionId &&
      previousSession.advertisedSessionId !== parsed.payload.status.sessionId
    ) {
      this.deleteSession({
        session: previousSession,
        closeHandshakingConnection: true,
      });

      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'session id mismatch',
      });
      this.log?.warn(`handshake from ${parsed.from} session id mismatch`, {
        ...conn.loggingMetadata,
        clientId: this.clientId,
        connectedTo: parsed.from,
        transportMessage: parsed,
      });
      this.protocolError(ProtocolError.HandshakeFailed, 'session id mismatch');
      return false;
    }

    this.log?.debug(`handshake from ${parsed.from} ok`, {
      ...conn.loggingMetadata,
      clientId: this.clientId,
      connectedTo: parsed.from,
      transportMessage: parsed,
    });

    const { session, isTransparentReconnect } = this.getOrCreateSession({
      to: parsed.from,
      conn,
      sessionId: parsed.payload.status.sessionId,
    });

    this.onConnect(conn, session, isTransparentReconnect);

    // After a successful connection, we start restoring the budget
    // so that the next time we try to connect, we don't hit the client
    // with backoff forever.
    this.retryBudget.startRestoringBudget(session.to);
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
    if (this.connections.has(to)) {
      this.log?.info(`already connected to ${to}, skipping connect attempt`, {
        clientId: this.clientId,
        connectedTo: to,
      });
      return;
    }

    const canProceedWithConnection = () => this.getStatus() === 'open';
    if (!canProceedWithConnection()) {
      this.log?.info(
        `transport state is no longer open, cancelling attempt to connect to ${to}`,
        { clientId: this.clientId, connectedTo: to },
      );
      return;
    }

    let reconnectPromise = this.inflightConnectionPromises.get(to);
    if (!reconnectPromise) {
      // check budget
      if (!this.retryBudget.hasBudget(to)) {
        const budgetConsumed = this.retryBudget.getBudgetConsumed(to);
        const errMsg = `tried to connect to ${to} but retry budget exceeded (more than ${budgetConsumed} attempts in the last ${this.retryBudget.totalBudgetRestoreTime}ms)`;
        this.log?.error(errMsg, { clientId: this.clientId, connectedTo: to });
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
        {
          clientId: this.clientId,
          connectedTo: to,
        },
      );
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
            this.log?.info(
              `transport state is no longer open, closing pre-handshake connection to ${to}`,
              {
                ...conn.loggingMetadata,
                clientId: this.clientId,
                connectedTo: to,
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
      this.log?.info(
        `attempting connection to ${to} (reusing previous attempt)`,
        {
          clientId: this.clientId,
          connectedTo: to,
        },
      );
    }

    try {
      await reconnectPromise;
    } catch (error: unknown) {
      this.inflightConnectionPromises.delete(to);
      const errStr = coerceErrorString(error);

      if (!this.reconnectOnConnectionDrop || !canProceedWithConnection()) {
        this.log?.warn(`connection to ${to} failed (${errStr})`, {
          clientId: this.clientId,
          connectedTo: to,
        });
      } else {
        this.log?.warn(`connection to ${to} failed (${errStr}), retrying`, {
          clientId: this.clientId,
          connectedTo: to,
        });
        await this.connect(to);
      }
    }
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
    this.inflightConnectionPromises.delete(session.to);
    super.deleteSession({
      session,
      closeHandshakingConnection,
      handshakingConn,
    });
  }

  protected async sendHandshake(to: TransportClientId, conn: ConnType) {
    let metadata: unknown = undefined;

    if (this.handshakeExtensions) {
      metadata = await this.handshakeExtensions.construct();
      if (!Value.Check(this.handshakeExtensions.schema, metadata)) {
        this.log?.error(`constructed handshake metadata did not match schema`, {
          ...conn.loggingMetadata,
          clientId: this.clientId,
          connectedTo: to,
          validationErrors: [
            ...Value.Errors(this.handshakeExtensions.schema, metadata),
          ],
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

    // don't pass conn here as we dont want the session to start using the conn
    // until we have finished the handshake. Still, let the session know that
    // it is semi-associated with the conn, and it can close it if .close() is called.
    const { session } = this.getOrCreateSession({ to, handshakingConn: conn });
    const requestMsg = handshakeRequestMessage({
      from: this.clientId,
      to,
      sessionId: session.id,
      expectedSessionState: {
        reconnect: session.advertisedSessionId !== undefined,
        nextExpectedSeq: session.nextExpectedSeq,
      },
      metadata,
      tracing: getPropagationContext(session.telemetry.ctx),
    });
    this.log?.debug(`sending handshake request to ${to}`, {
      ...conn.loggingMetadata,
      clientId: this.clientId,
      connectedTo: to,
      transportMessage: requestMsg,
    });
    conn.send(this.codec.toBuffer(requestMsg));
    return true;
  }

  close() {
    this.retryBudget.close();
    super.close();
  }
}
