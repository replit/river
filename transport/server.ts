import { SpanStatusCode } from '@opentelemetry/api';
import { ParsedMetadata } from '../router/context';
import { ServerHandshakeOptions } from '../router/handshake';
import {
  ControlMessageHandshakeRequestSchema,
  HandshakeErrorResponseCodes,
  OpaqueTransportMessage,
  acceptedProtocolVersions,
  PartialTransportMessage,
  TransportClientId,
  handshakeResponseMessage,
  currentProtocolVersion,
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
import { MessageMetadata } from '../logging';
import { SessionWaitingForHandshake } from './sessionStateMachine/SessionWaitingForHandshake';
import { SessionState } from './sessionStateMachine/common';
import {
  ServerSession,
  ServerSessionStateGraph,
} from './sessionStateMachine/transitions';

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
  sessionHandshakeMetadata = new Map<TransportClientId, ParsedMetadata>();

  sessions = new Map<TransportClientId, ServerSession<ConnType>>();
  pendingSessions = new Set<SessionWaitingForHandshake<ConnType>>();

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

  extendHandshake(options: ServerHandshakeOptions) {
    this.handshakeExtensions = options;
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

    const session = this.sessions.get(to);
    if (!session) {
      const err = `session to ${to} does not exist`;
      this.log?.error(err, {
        clientId: this.clientId,
        transportMessage: msg,
        tags: ['invariant-violation'],
      });

      throw new Error(err);
    }

    return session.send(msg);
  }

  protected deletePendingSession(
    pendingSession: SessionWaitingForHandshake<ConnType>,
  ) {
    pendingSession.close();
    // we don't dispatch a session disconnect event
    // for a non-identified session, just delete directly

    this.pendingSessions.delete(pendingSession);
  }

  protected deleteSession(session: ServerSession<ConnType>): void {
    this.sessionHandshakeMetadata.delete(session.to);
    super.deleteSession(session);
  }

  protected handleConnection(conn: ConnType) {
    if (this.getStatus() !== 'open') return;

    this.log?.info(`new incoming connection`, {
      ...conn.loggingMetadata,
      clientId: this.clientId,
    });

    let receivedHandshake = false;
    const pendingSession = ServerSessionStateGraph.entrypoint(
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
        onInvalidHandshake: (reason) => {
          this.log?.error(
            `invalid handshake: ${reason}`,
            pendingSession.loggingMetadata,
          );
          this.deletePendingSession(pendingSession);
          this.protocolError(ProtocolError.HandshakeFailed, reason);
        },
      },
      this.options,
      this.log,
    );

    this.pendingSessions.add(pendingSession);
  }

  private rejectHandshakeRequest(
    session: SessionWaitingForHandshake<ConnType>,
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
    session: SessionWaitingForHandshake<ConnType>,
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
    if (!acceptedProtocolVersions.includes(gotVersion)) {
      this.rejectHandshakeRequest(
        session,
        msg.from,
        `expected protocol version oneof [${acceptedProtocolVersions.toString()}], got ${gotVersion}`,
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

    // 4 connect cases
    // 1. new session
    //    we dont have a session and the client is requesting a new one
    //    we can create the session as normal
    // 2. client is reconnecting to an existing session but we don't have it
    //    reject this handshake, there's nothing we can do to salvage it
    // 3. transparent reconnect (old session exists and is the same as the client wants)
    //    assign to old session
    // 4. hard reconnect (oldSession exists but but the client wants a new one)
    //    we close the old session and create a new one
    let connectCase:
      | 'new session'
      | 'unknown session'
      | 'transparent reconnection'
      | 'hard reconnection' = 'new session';
    const clientNextExpectedSeq =
      msg.payload.expectedSessionState.nextExpectedSeq;
    const clientNextSentSeq = msg.payload.expectedSessionState.nextSentSeq ?? 0;

    if (oldSession && oldSession.id === msg.payload.sessionId) {
      connectCase = 'transparent reconnection';

      // invariant: ordering must be correct
      const ourNextSeq = oldSession.nextSeq();
      const ourAck = oldSession.ack;

      // two incorrect cases where we cannot permit a reconnect:
      // - if the client is about to send a message in the future w.r.t to the server
      //  - client.seq > server.ack => nextSentSeq > oldSession.ack
      if (clientNextSentSeq > ourAck) {
        this.rejectHandshakeRequest(
          session,
          msg.from,
          `client is in the future: server wanted next message to be ${ourAck} but client would have sent ${clientNextSentSeq}`,
          'SESSION_STATE_MISMATCH',
          {
            ...session.loggingMetadata,
            connectedTo: msg.from,
            transportMessage: msg,
          },
        );

        return;
      }

      // - if the server is about to send a message in the future w.r.t to the client
      //  - server.seq > client.ack => oldSession.nextSeq() > nextExpectedSeq
      if (ourNextSeq > clientNextExpectedSeq) {
        this.rejectHandshakeRequest(
          session,
          msg.from,
          `server is in the future: client wanted next message to be ${clientNextExpectedSeq} but server would have sent ${ourNextSeq}`,
          'SESSION_STATE_MISMATCH',
          {
            ...session.loggingMetadata,
            connectedTo: msg.from,
            transportMessage: msg,
          },
        );

        return;
      }

      // transparent reconnect seems ok, proceed by transitioning old session
      // to not connected
      if (oldSession.state !== SessionState.NoConnection) {
        const noConnectionSession =
          ServerSessionStateGraph.transition.ConnectedToNoConnection(
            oldSession,
            {
              onSessionGracePeriodElapsed: () => {
                this.onSessionGracePeriodElapsed(noConnectionSession);
              },
            },
          );

        oldSession = noConnectionSession;
      }

      this.updateSession(oldSession);
    } else if (oldSession) {
      connectCase = 'hard reconnection';

      // just nuke the old session entirely and proceed as if this was new
      this.log?.info(
        `client is reconnecting to a new session (${msg.payload.sessionId}) with an old session (${oldSession.id}) already existing, closing old session`,
        {
          ...session.loggingMetadata,
          connectedTo: msg.from,
          sessionId: msg.payload.sessionId,
        },
      );
      this.deleteSession(oldSession);
      oldSession = undefined;
    }

    if (!oldSession && (clientNextSentSeq > 0 || clientNextExpectedSeq > 0)) {
      // we don't have a session, but the client is trying to reconnect
      // to an old session. we can't do anything about this, so we reject
      connectCase = 'unknown session';
      this.rejectHandshakeRequest(
        session,
        msg.from,
        `client is trying to reconnect to a session the server don't know about: ${msg.payload.sessionId}`,
        'SESSION_STATE_MISMATCH',
        {
          ...session.loggingMetadata,
          connectedTo: msg.from,
          transportMessage: msg,
        },
      );
      return;
    }

    // from this point on, we're committed to connecting
    const sessionId = msg.payload.sessionId;
    this.log?.info(
      `handshake from ${msg.from} ok (${connectCase}), responding with handshake success`,
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

    // transition
    const connectedSession =
      ServerSessionStateGraph.transition.WaitingForHandshakeToConnected(
        session,
        // by this point oldSession is either no connection or we dont have an old session
        oldSession,
        sessionId,
        msg.from,
        msg.tracing,
        {
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
            this.protocolError(ProtocolError.MessageOrderingViolated, reason);
            this.deleteSession(connectedSession);
          },
        },
        gotVersion,
      );

    this.sessionHandshakeMetadata.set(connectedSession.to, parsedMetadata);
    this.updateSession(connectedSession);
    this.pendingSessions.delete(session);
    connectedSession.startActiveHeartbeat();
  }

  private async validateHandshakeMetadata(
    handshakingSession: SessionWaitingForHandshake<ConnType>,
    existingSession: ServerSession<ConnType> | undefined,
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
        ? this.sessionHandshakeMetadata.get(existingSession.to)
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
