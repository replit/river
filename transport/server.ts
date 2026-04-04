import { SpanStatusCode } from '@opentelemetry/api';
import { ServerHandshakeOptions } from '../router/handshake';
import {
  ControlMessageHandshakeRequestSchema,
  HandshakeErrorCustomHandlerFatalResponseCodes,
  HandshakeErrorResponseCodes,
  OpaqueTransportMessage,
  acceptedProtocolVersions,
  TransportClientId,
  handshakeResponseMessage,
  currentProtocolVersion,
  isAcceptedProtocolVersion,
} from './message';
import {
  ProvidedServerTransportOptions,
  ServerTransportOptions,
  defaultServerTransportOptions,
} from './options';
import { DeleteSessionOptions, Transport } from './transport';
import { coerceErrorString } from './stringifyError';
import { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ProtocolError } from './events';
import { Connection } from './connection';
import { MessageMetadata } from '../logging';
import { Session, SessionState } from './session';
import { CodecMessageAdapter } from '../codec';
import {
  createSessionTelemetryInfo,
  createConnectionTelemetryInfo,
} from '../tracing';
import { withResolvers, call } from 'effection';
import type { Operation, Task } from 'effection';

/**
 * Tracks a pending connection that is waiting for the client to send
 * a handshake request. This replaces the old SessionWaitingForHandshake class.
 */
interface PendingConnection<ConnType extends Connection> {
  conn: ConnType;
  codec: CodecMessageAdapter;
  handshakeTimeout?: ReturnType<typeof setTimeout>;
  task?: Task<void>;
}

export abstract class ServerTransport<
  ConnType extends Connection,
  MetadataSchema extends TSchema = TSchema,
  ParsedMetadata extends object = object,
> extends Transport<ConnType> {
  protected options: ServerTransportOptions;
  handshakeExtensions?: ServerHandshakeOptions<MetadataSchema, ParsedMetadata>;
  sessionHandshakeMetadata = new Map<TransportClientId, ParsedMetadata>();

  sessions = new Map<TransportClientId, Session>();
  pendingSessions = new Set<PendingConnection<ConnType>>();

  constructor(
    clientId: TransportClientId,
    providedOptions?: ProvidedServerTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.sessions = new Map();
    this.options = {
      ...defaultServerTransportOptions,
      ...providedOptions,
    };
    this.log?.info(`initiated server transport`, {
      clientId: this.clientId,
      protocolVersion: currentProtocolVersion,
    });
  }

  extendHandshake(
    options: ServerHandshakeOptions<MetadataSchema, ParsedMetadata>,
  ) {
    this.handshakeExtensions = options;
  }

  protected deletePendingSession(
    pending: PendingConnection<ConnType>,
  ) {
    pending.conn.close();
    if (pending.handshakeTimeout) {
      clearTimeout(pending.handshakeTimeout);
    }
    pending.conn.removeDataListener();
    pending.conn.removeCloseListener();
    pending.conn.removeErrorListener();
    if (pending.task) {
      void pending.task.halt();
    }
    this.pendingSessions.delete(pending);
  }

  protected deleteSession(
    session: Session,
    options?: DeleteSessionOptions,
  ): void {
    this.sessionHandshakeMetadata.delete(session.to);
    super.deleteSession(session, options);
  }

  protected handleConnection(conn: ConnType) {
    if (this.getStatus() !== 'open') return;

    this.log?.info(`new incoming connection`, {
      ...conn.loggingMetadata,
      clientId: this.clientId,
    });

    const codec = new CodecMessageAdapter(this.options.codec);
    const pending: PendingConnection<ConnType> = {
      conn,
      codec,
    };
    this.pendingSessions.add(pending);

    let receivedHandshake = false;

    // Set up listeners for the pending connection
    conn.setCloseListener(() => {
      this.log?.warn(
        `connection from unknown closed before handshake finished`,
        { clientId: this.clientId, connId: conn.id },
      );
      this.deletePendingSession(pending);
    });

    conn.setErrorListener((err: Error) => {
      const errorString = coerceErrorString(err);
      this.log?.warn(
        `connection from unknown errored before handshake finished: ${errorString}`,
        { clientId: this.clientId, connId: conn.id },
      );
      this.deletePendingSession(pending);
    });

    conn.setDataListener((raw: Uint8Array) => {
      const parsedMsgRes = codec.fromBuffer(raw);
      if (!parsedMsgRes.ok) {
        this.log?.error(
          `invalid handshake: could not parse handshake message: ${parsedMsgRes.reason}`,
          { clientId: this.clientId, connId: conn.id },
        );
        this.deletePendingSession(pending);
        this.protocolError({
          type: ProtocolError.HandshakeFailed,
          code: 'MALFORMED_HANDSHAKE',
          message: `could not parse handshake message: ${parsedMsgRes.reason}`,
        });
        return;
      }

      if (receivedHandshake) {
        this.log?.error(
          `received multiple handshake messages from pending session`,
          {
            clientId: this.clientId,
            connId: conn.id,
            connectedTo: parsedMsgRes.value.from,
            transportMessage: parsedMsgRes.value,
          },
        );
        this.deletePendingSession(pending);
        return;
      }

      receivedHandshake = true;
      // Process handshake asynchronously (custom validation may be async)
      const task = this.scope.run(() =>
        this.processHandshakeRequest(pending, parsedMsgRes.value),
      );
      pending.task = task;
    });

    // Handshake timeout
    pending.handshakeTimeout = setTimeout(() => {
      this.log?.warn(
        `connection from unknown timed out before handshake finished`,
        { clientId: this.clientId, connId: conn.id },
      );
      this.deletePendingSession(pending);
    }, this.options.handshakeTimeoutMs);
  }

  private rejectHandshakeRequest(
    pending: PendingConnection<ConnType>,
    to: TransportClientId,
    reason: string,
    code: Static<typeof HandshakeErrorResponseCodes>,
    metadata: MessageMetadata,
  ) {
    pending.conn.telemetry?.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: reason,
    });

    this.log?.warn(reason, metadata);

    const responseMsg = handshakeResponseMessage({
      from: this.clientId,
      to,
      status: {
        ok: false,
        code,
        reason,
      },
    });

    const buff = pending.codec.toBuffer(responseMsg);
    if (!buff.ok) {
      this.log?.error(`failed to encode handshake response: ${buff.reason}`, metadata);
      this.protocolError({
        type: ProtocolError.MessageSendFailure,
        message: buff.reason,
      });
      this.deletePendingSession(pending);
      return;
    }

    const sent = pending.conn.send(buff.value);
    if (!sent) {
      this.log?.error(`failed to send handshake response`, metadata);
      this.protocolError({
        type: ProtocolError.MessageSendFailure,
        message: 'failed to send handshake response',
      });
      this.deletePendingSession(pending);
      return;
    }

    this.protocolError({
      type: ProtocolError.HandshakeFailed,
      code,
      message: reason,
    });
    this.deletePendingSession(pending);
  }

  private *processHandshakeRequest(
    pending: PendingConnection<ConnType>,
    msg: OpaqueTransportMessage,
  ): Operation<void> {
    const conn = pending.conn;

    // Validate handshake request schema
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload = msg.payload as any;
    if (!Value.Check(ControlMessageHandshakeRequestSchema, payload)) {
      this.rejectHandshakeRequest(
        pending,
        msg.from,
        'received invalid handshake request',
        'MALFORMED_HANDSHAKE',
        {
          clientId: this.clientId,
          connId: conn.id,
          connectedTo: msg.from,
          transportMessage: msg,
          validationErrors: [
            ...Value.Errors(ControlMessageHandshakeRequestSchema, payload),
          ],
        },
      );
      return;
    }

    // Validate protocol version
    const gotVersion = payload.protocolVersion;
    if (!isAcceptedProtocolVersion(gotVersion)) {
      this.rejectHandshakeRequest(
        pending,
        msg.from,
        `expected protocol version oneof [${acceptedProtocolVersions.toString()}], got ${gotVersion}`,
        'PROTOCOL_VERSION_MISMATCH',
        {
          clientId: this.clientId,
          connId: conn.id,
          connectedTo: msg.from,
          transportMessage: msg,
        },
      );
      return;
    }

    // Validate custom handshake metadata
    let parsedMetadata: ParsedMetadata = {} as ParsedMetadata;
    if (this.handshakeExtensions) {
      if (!Value.Check(this.handshakeExtensions.schema, payload.metadata)) {
        this.rejectHandshakeRequest(
          pending,
          msg.from,
          'received malformed handshake metadata',
          'MALFORMED_HANDSHAKE_META',
          {
            clientId: this.clientId,
            connId: conn.id,
            connectedTo: msg.from,
            validationErrors: [
              ...Value.Errors(
                this.handshakeExtensions.schema,
                payload.metadata,
              ),
            ],
          },
        );
        return;
      }

      const previousParsedMetadata = this.sessionHandshakeMetadata.get(
        msg.from,
      );

      const parsedMetadataOrFailureCode = yield* call(() =>
        this.handshakeExtensions!.validate(
          payload.metadata,
          previousParsedMetadata,
        ),
      );

      if (
        Value.Check(
          HandshakeErrorCustomHandlerFatalResponseCodes,
          parsedMetadataOrFailureCode,
        )
      ) {
        this.rejectHandshakeRequest(
          pending,
          msg.from,
          'rejected by handshake handler',
          parsedMetadataOrFailureCode,
          {
            clientId: this.clientId,
            connId: conn.id,
            connectedTo: msg.from,
          },
        );
        return;
      }

      parsedMetadata = parsedMetadataOrFailureCode as ParsedMetadata;
    }

    // Determine connect case
    const clientNextExpectedSeq =
      payload.expectedSessionState.nextExpectedSeq;
    const clientNextSentSeq = payload.expectedSessionState.nextSentSeq;

    let connectCase:
      | 'new session'
      | 'unknown session'
      | 'transparent reconnection'
      | 'hard reconnection' = 'new session';

    let oldSession = this.sessions.get(msg.from);

    if (
      this.options.enableTransparentSessionReconnects &&
      oldSession &&
      oldSession.id === payload.sessionId
    ) {
      connectCase = 'transparent reconnection';

      const ourNextSeq = oldSession.nextSeq();
      const ourAck = oldSession.ack;

      if (clientNextSentSeq > ourAck) {
        this.rejectHandshakeRequest(
          pending,
          msg.from,
          `client is in the future: server wanted next message to be ${ourAck} but client would have sent ${clientNextSentSeq}`,
          'SESSION_STATE_MISMATCH',
          {
            clientId: this.clientId,
            connId: conn.id,
            connectedTo: msg.from,
            transportMessage: msg,
          },
        );
        return;
      }

      if (ourNextSeq > clientNextExpectedSeq) {
        this.rejectHandshakeRequest(
          pending,
          msg.from,
          `server is in the future: client wanted next message to be ${clientNextExpectedSeq} but server would have sent ${ourNextSeq}`,
          'SESSION_STATE_MISMATCH',
          {
            clientId: this.clientId,
            connId: conn.id,
            connectedTo: msg.from,
            transportMessage: msg,
          },
        );
        return;
      }

      // Close old connection if still active
      if (oldSession.conn) {
        oldSession.conn.close();
        oldSession.conn = null;
      }
      oldSession._state = SessionState.NoConnection;
    } else if (oldSession) {
      connectCase = 'hard reconnection';
      this.log?.info(
        `client is reconnecting to a new session (${payload.sessionId}) with an old session (${oldSession.id}) already existing, closing old session`,
        {
          clientId: this.clientId,
          connId: conn.id,
          connectedTo: msg.from,
          sessionId: payload.sessionId,
        },
      );
      this.deleteSession(oldSession);
      oldSession = undefined;
    }

    if (!oldSession && (clientNextSentSeq > 0 || clientNextExpectedSeq > 0)) {
      connectCase = 'unknown session';
      const rejectionMessage = this.options.enableTransparentSessionReconnects
        ? `client is trying to reconnect to a session the server don't know about: ${payload.sessionId}`
        : `client is attempting a transparent reconnect to a session but the server does not support it: ${payload.sessionId}`;

      this.rejectHandshakeRequest(
        pending,
        msg.from,
        rejectionMessage,
        'SESSION_STATE_MISMATCH',
        {
          clientId: this.clientId,
          connId: conn.id,
          connectedTo: msg.from,
          transportMessage: msg,
        },
      );
      return;
    }

    // Send handshake response
    const sessionId = payload.sessionId;
    this.log?.info(
      `handshake from ${msg.from} ok (${connectCase}), responding with handshake success`,
      {
        clientId: this.clientId,
        connId: conn.id,
        connectedTo: msg.from,
      },
    );

    const responseMsg = handshakeResponseMessage({
      from: this.clientId,
      to: msg.from,
      status: {
        ok: true,
        sessionId,
      },
    });

    const buff = pending.codec.toBuffer(responseMsg);
    if (!buff.ok) {
      this.log?.error(`failed to encode handshake response: ${buff.reason}`, {
        clientId: this.clientId,
        connId: conn.id,
      });
      this.protocolError({
        type: ProtocolError.MessageSendFailure,
        message: buff.reason,
      });
      this.deletePendingSession(pending);
      return;
    }

    const sent = conn.send(buff.value);
    if (!sent) {
      this.log?.error(`failed to send handshake response`, {
        clientId: this.clientId,
        connId: conn.id,
      });
      this.protocolError({
        type: ProtocolError.MessageSendFailure,
        message: 'failed to send handshake response',
      });
      this.deletePendingSession(pending);
      return;
    }

    // Clean up pending session state (but don't close the connection)
    if (pending.handshakeTimeout) {
      clearTimeout(pending.handshakeTimeout);
    }
    conn.removeDataListener();
    conn.removeCloseListener();
    conn.removeErrorListener();
    this.pendingSessions.delete(pending);

    // Create or update session
    let session: Session;
    if (oldSession) {
      // Transparent reconnect - reuse existing session
      session = oldSession;
      session.conn = conn;
      session._state = SessionState.Connected;

      conn.telemetry = createConnectionTelemetryInfo(
        session.tracer,
        conn,
        session.telemetry,
      );
    } else {
      // New session
      const telemetry = createSessionTelemetryInfo(
        this.tracer,
        sessionId,
        msg.from,
        this.clientId,
        msg.tracing,
      );

      session = new Session({
        id: sessionId,
        from: this.clientId,
        to: msg.from,
        seq: 0,
        ack: 0,
        seqSent: 0,
        sendBuffer: [],
        telemetry,
        options: this.options,
        protocolVersion: gotVersion,
        tracer: this.tracer,
        log: this.log,
        codec: new CodecMessageAdapter(this.options.codec),
        state: SessionState.Connected,
      });

      session.conn = conn;
      conn.telemetry = createConnectionTelemetryInfo(
        session.tracer,
        conn,
        session.telemetry,
      );

      this.createSessionEntry(session);
    }

    if (oldSession) {
      // Transparent reconnect - session already in map, just dispatch transition
      this.dispatchSessionTransition(session);
    }

    this.log?.info(
      `session ${session.id} transition to Connected`,
      {
        ...session.loggingMetadata,
        tags: ['state-transition'],
      },
    );

    // Send buffered messages
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

    this.sessionHandshakeMetadata.set(session.to, parsedMetadata);

    // Run connected phase with active heartbeat (server-side)
    // Handle disconnect synchronously via the close listener
    const self = this;

    const onDisconnect = () => {
      if (session._isConsumed) {
        return;
      }

      self.log?.info(
        `connection to ${session.to} closed`,
        session.loggingMetadata,
      );

      session.conn = null;
      session._state = SessionState.NoConnection;
      self.dispatchSessionTransition(session);

      // Start grace period for transparent reconnection
      const graceMs = session.options.sessionDisconnectGraceMs;
      const graceTimeout = setTimeout(() => {
        if (!session._isConsumed) {
          self.log?.info(
            `session to ${session.to} grace period elapsed, closing`,
            session.loggingMetadata,
          );
          self.deleteSession(session);
        }
      }, graceMs);

      // Store grace timeout so it can be cleaned up if session reconnects
      self.sessionTasks.get(session.to);
    };

    const connectedTask = this.scope.run(function* () {
      yield* self.runConnectedPhase(session, conn, true, onDisconnect);
    });
    this.sessionTasks.set(session.to, connectedTask);
  }

  /**
   * Run the connected phase with heartbeat and message handling.
   * Reuses the ClientTransport implementation via the base class.
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
      this.log?.warn(
        `connection to ${session.to} errored: ${errStr}`,
        session.loggingMetadata,
      );
    });

    conn.setCloseListener(() => {
      // Clean up immediately on close (synchronous)
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

      // Call the synchronous disconnect handler
      onDisconnect?.();

      resolveDisconnect();
    });

    yield* disconnectOp;
  }

  close() {
    // Clean up pending sessions
    for (const pending of this.pendingSessions) {
      this.deletePendingSession(pending);
    }

    super.close();
  }
}
