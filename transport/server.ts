import { SpanStatusCode } from '@opentelemetry/api';
import { ParsedMetadata } from '../router/context';
import { ServerHandshakeOptions } from '../router/handshake';
import {
  ControlMessageHandshakeRequestSchema,
  HandshakeErrorResponseCodes,
  OpaqueTransportMessage,
  PROTOCOL_VERSION,
  TransportClientId,
  handshakeResponseMessage,
} from './message';
import {
  ProvidedServerTransportOptions,
  ServerTransportOptions,
  defaultServerTransportOptions,
} from './options';
import { Transport } from './transport';
import { coerceErrorString } from '../util/stringify';
import { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ProtocolError } from './events';
import { Connection } from './connection';
import {
  Session,
  SessionPendingIdentification,
  SessionState,
  SessionStateMachine,
} from './sessionStateMachine';
import { MessageMetadata } from '../logging';

export abstract class ServerTransport<
  ConnType extends Connection,
> extends Transport<ConnType> {
  /**
   * The options for this transport.
   */
  protected options: ServerTransportOptions;

  /**
   * Optional handshake options for the server.
   */
  handshakeExtensions?: ServerHandshakeOptions;

  /**
   * A map of session handshake data for each session.
   */
  sessionHandshakeMetadata: WeakMap<Session<ConnType>, ParsedMetadata>;
  pendingSessions = new Set<SessionPendingIdentification<ConnType>>();

  constructor(
    clientId: TransportClientId,
    providedOptions?: ProvidedServerTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.options = {
      ...defaultServerTransportOptions,
      ...providedOptions,
    };
    this.sessionHandshakeMetadata = new WeakMap();
    this.log?.info(`initiated server transport`, {
      clientId: this.clientId,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  extendHandshake(options: ServerHandshakeOptions) {
    this.handshakeExtensions = options;
  }

  protected deletePendingSession(
    pendingSession: SessionPendingIdentification<ConnType>,
  ) {
    pendingSession.close();
    // we don't dispatch a session disconnect event
    // for a non-identified session, just delete directly

    this.pendingSessions.delete(pendingSession);
  }

  protected handleConnection(conn: ConnType) {
    if (this.getStatus() !== 'open') return;

    this.log?.info(`new incoming connection`, {
      ...conn.loggingMetadata,
      clientId: this.clientId,
    });

    let receivedHandshake = false;
    const pendingSession =
      SessionStateMachine.entrypoints.PendingIdentification(
        this.clientId,
        conn,
        {
          onConnectionClosed: () => {
            this.log?.warn(
              `connection from unknown closed before handshake finished`,
              pendingSession.loggingMetadata,
            );

            this.deletePendingSession(pendingSession);
          },
          onConnectionErrored: (err) => {
            const errorString = coerceErrorString(err);
            this.log?.warn(
              `connection from unknown errored before handshake finished: ${errorString}`,
              pendingSession.loggingMetadata,
            );

            this.deletePendingSession(pendingSession);
          },
          onHandshakeTimeout: () => {
            this.log?.warn(
              `connection from unknown timed out before handshake finished`,
              pendingSession.loggingMetadata,
            );

            this.deletePendingSession(pendingSession);
          },
          onHandshake: (msg) => {
            if (receivedHandshake) {
              this.log?.error(
                `received multiple handshake messages from pending session`,
                {
                  ...pendingSession.loggingMetadata,
                  connectedTo: msg.from,
                  transportMessage: msg,
                },
              );

              this.deletePendingSession(pendingSession);
              return;
            }

            // let this resolve async, we just need to make sure its only
            // called once so we don't race while transitioning to connected
            // onHandshakeRequest is async as custom validation may be async
            receivedHandshake = true;
            void this.onHandshakeRequest(pendingSession, msg);
          },
        },
        this.options,
      );

    this.pendingSessions.add(pendingSession);
  }

  private rejectHandshakeRequest(
    session: SessionPendingIdentification<ConnType>,
    to: TransportClientId,
    reason: string,
    code: Static<typeof HandshakeErrorResponseCodes>,
    metadata: MessageMetadata,
  ) {
    session.conn.telemetry?.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: reason,
    });

    this.log?.warn(reason, metadata);

    session.sendHandshake(
      handshakeResponseMessage({
        from: this.clientId,
        to,
        status: {
          ok: false,
          code,
          reason,
        },
      }),
    );

    this.protocolError(ProtocolError.HandshakeFailed, reason);
    this.deletePendingSession(session);
  }

  protected async onHandshakeRequest(
    session: SessionPendingIdentification<ConnType>,
    msg: OpaqueTransportMessage,
  ) {
    // invariant: msg is a handshake request
    if (!Value.Check(ControlMessageHandshakeRequestSchema, msg.payload)) {
      this.rejectHandshakeRequest(
        session,
        msg.from,
        'received invalid handshake request',
        'MALFORMED_HANDSHAKE',
        {
          ...session.loggingMetadata,
          transportMessage: msg,
          connectedTo: msg.from,
          validationErrors: [
            ...Value.Errors(ControlMessageHandshakeRequestSchema, msg.payload),
          ],
        },
      );

      return;
    }

    // invariant: handshake request passes all the validation
    const gotVersion = msg.payload.protocolVersion;
    if (gotVersion !== PROTOCOL_VERSION) {
      this.rejectHandshakeRequest(
        session,
        msg.from,
        `expected protocol version ${PROTOCOL_VERSION}, got ${gotVersion}`,
        'PROTOCOL_VERSION_MISMATCH',
        {
          ...session.loggingMetadata,
          connectedTo: msg.from,
          transportMessage: msg,
        },
      );

      return;
    }

    let oldSession = this.sessions.get(msg.from);

    // invariant: must pass custom validation if defined
    const parsedMetadata = await this.validateHandshakeMetadata(
      session,
      oldSession,
      msg.payload.metadata,
      msg.from,
    );

    if (parsedMetadata === false) {
      return;
    }

    // invariant: must either match an existing session (be a reconnect)
    // or be a new session
    if (oldSession) {
      // invariant: if it's a reconnect, the session id must match
      if (oldSession.id !== msg.payload.sessionId) {
        this.rejectHandshakeRequest(
          session,
          msg.from,
          `session id mismatch, expected ${oldSession.id}, got ${msg.payload.sessionId}`,
          'SESSION_STATE_MISMATCH',
          {
            ...session.loggingMetadata,
            connectedTo: msg.from,
            transportMessage: msg,
          },
        );

        return;
      }

      // invariant: next expected seq must be the next seq we would send
      const nextExpectedSeq = msg.payload.expectedSessionState.nextExpectedSeq;
      const ourNextSeq =
        oldSession.sendBuffer.length > 0
          ? // if we have messages buffered, the next message we would send is the first buffered
            oldSession.sendBuffer[0].seq
          : // otherwise it's the current seq
            oldSession.seq;
      if (nextExpectedSeq !== ourNextSeq) {
        this.rejectHandshakeRequest(
          session,
          msg.from,
          `client wanted next message to be ${nextExpectedSeq} but we would have sent ${ourNextSeq}`,
          'SESSION_STATE_MISMATCH',
          {
            ...session.loggingMetadata,
            connectedTo: msg.from,
            transportMessage: msg,
          },
        );

        return;
      }
    }

    // from this point on, we're committed to connecting
    const sessionId = msg.payload.sessionId;
    this.log?.debug(
      `handshake from ${msg.from} ok, responding with handshake success`,
      {
        ...session.loggingMetadata,
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
    session.sendHandshake(responseMsg);

    // if we have an old session, make sure we transition it to not connected before
    // we transition the new session to connected
    if (oldSession) {
      if (oldSession.state === SessionState.Connected) {
        const noConnectionSession =
          SessionStateMachine.transition.ConnectedToNoConnection(oldSession, {
            onSessionGracePeriodElapsed: () => {
              this.onSessionGracePeriodElapsed(noConnectionSession);
            },
          });

        oldSession = noConnectionSession;
      } else if (oldSession.state === SessionState.Handshaking) {
        const noConnectionSession =
          SessionStateMachine.transition.HandshakingToNoConnection(oldSession, {
            onSessionGracePeriodElapsed: () => {
              this.onSessionGracePeriodElapsed(noConnectionSession);
            },
          });

        oldSession = noConnectionSession;
      } else if (oldSession.state === SessionState.Connecting) {
        const noConnectionSession =
          SessionStateMachine.transition.ConnectingToNoConnection(oldSession, {
            onSessionGracePeriodElapsed: () => {
              this.onSessionGracePeriodElapsed(noConnectionSession);
            },
          });

        oldSession = noConnectionSession;
      }

      this.updateSession(oldSession);
    }

    // transition
    const connectedSession =
      SessionStateMachine.transition.PendingIdentificationToConnected(
        session,
        // by this point oldSession is either no connection or we dont have an old session
        oldSession,
        sessionId,
        msg.from,
        {
          onConnectionErrored: (err) => {
            // just log, when we error we also emit close
            const errStr = coerceErrorString(err);
            this.log?.error(
              `connection to ${connectedSession.to} errored: ${errStr}`,
              connectedSession.loggingMetadata,
            );
          },
          onConnectionClosed: () => {
            this.log?.error(
              `connection to ${connectedSession.to} closed`,
              connectedSession.loggingMetadata,
            );
            this.onConnClosed(connectedSession);
          },
          onMessage: (msg) => this.handleMsg(msg),
        },
      );

    this.sessionHandshakeMetadata.set(connectedSession, parsedMetadata);
    this.updateSession(connectedSession);
  }

  private async validateHandshakeMetadata(
    handshakingSession: SessionPendingIdentification<ConnType>,
    existingSession: Session<ConnType> | undefined,
    rawMetadata: Static<
      typeof ControlMessageHandshakeRequestSchema
    >['metadata'],
    from: TransportClientId,
  ): Promise<ParsedMetadata | false> {
    let parsedMetadata: ParsedMetadata = {};
    if (this.handshakeExtensions) {
      // check that the metadata that was sent is the correct shape
      if (!Value.Check(this.handshakeExtensions.schema, rawMetadata)) {
        this.rejectHandshakeRequest(
          handshakingSession,
          from,
          'received malformed handshake metadata',
          'MALFORMED_HANDSHAKE_META',
          {
            ...handshakingSession.loggingMetadata,
            connectedTo: from,
            validationErrors: [
              ...Value.Errors(this.handshakeExtensions.schema, rawMetadata),
            ],
          },
        );

        return false;
      }

      const previousParsedMetadata = existingSession
        ? this.sessionHandshakeMetadata.get(existingSession)
        : undefined;

      parsedMetadata = await this.handshakeExtensions.validate(
        rawMetadata,
        previousParsedMetadata,
      );

      // handler rejected the connection
      if (parsedMetadata === false) {
        this.rejectHandshakeRequest(
          handshakingSession,
          from,
          'rejected by handshake handler',
          'REJECTED_BY_CUSTOM_HANDLER',
          {
            ...handshakingSession.loggingMetadata,
            connectedTo: from,
            clientId: this.clientId,
          },
        );

        return false;
      }
    }

    return parsedMetadata;
  }
}
