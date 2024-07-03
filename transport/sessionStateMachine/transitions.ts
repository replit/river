import { OpaqueTransportMessage, TransportClientId } from '..';
import {
  SessionConnecting,
  SessionConnectingListeners,
} from './SessionConnecting';
import {
  SessionNoConnection,
  SessionNoConnectionListeners,
} from './SessionNoConnection';
import { IdentifiedSession, SessionOptions } from './common';
import { PropagationContext, createSessionTelemetryInfo } from '../../tracing';
import { SessionPendingIdentification } from './SessionPendingIdentification';
import {
  SessionHandshaking,
  SessionHandshakingListeners,
} from './SessionHandshaking';
import {
  SessionConnected,
  SessionConnectedListeners,
} from './SessionConnected';
import { generateId } from '../id';
import { Connection } from '../connection';

function inheritSharedSession(
  session: IdentifiedSession,
): ConstructorParameters<typeof IdentifiedSession> {
  return [
    session.id,
    session.from,
    session.to,
    session.seq,
    session.ack,
    session.sendBuffer,
    session.telemetry,
    session.options,
    session.log,
  ];
}

/*
 * Session state machine:
 * 1. SessionNoConnection is the client entrypoint as
 *    we know who the other side is already, we just need to connect
 * 5. SessionPendingIdentification is the server entrypoint
 *    as we have a connection but don't know who the other side is yet
 *
 *                           1. SessionNoConnection         ◄──┐
 *                           │  reconnect / connect attempt    │
 *                           ▼                                 │
 *                           2. SessionConnecting              │
 *                           │  connect success  ──────────────┤ connect failure
 *                           ▼                                 │
 *                           3. SessionHandshaking             │
 *                           │  handshake success       ┌──────┤ connection drop
 * 5. PendingIdentification  │  handshake failure  ─────┤      │
 * │  handshake success      ▼                          │      │ connection drop
 * ├───────────────────────► 4. SessionConnected        │      │ heartbeat misses
 * │                         │  invalid message  ───────┼──────┘
 * │                         ▼                          │
 * └───────────────────────► x. Destroy Session   ◄─────┘
 *   handshake failure
 */
export const SessionStateMachine = {
  entrypoints: {
    NoConnection(
      to: TransportClientId,
      from: TransportClientId,
      listeners: SessionNoConnectionListeners,
      options: SessionOptions,
    ) {
      const id = `session-${generateId()}`;
      const telemetry = createSessionTelemetryInfo(id, to, from);
      const sendBuffer: Array<OpaqueTransportMessage> = [];

      return new SessionNoConnection(
        listeners,
        id,
        from,
        to,
        0,
        0,
        sendBuffer,
        telemetry,
        options,
        undefined,
      );
    },
    PendingIdentification<ConnType extends Connection>(
      from: TransportClientId,
      conn: ConnType,
      listeners: SessionHandshakingListeners,
      options: SessionOptions,
    ): SessionPendingIdentification<ConnType> {
      return new SessionPendingIdentification(conn, listeners, from, options);
    },
  },
  transition: {
    // happy path transitions
    NoConnectionToConnecting<ConnType extends Connection>(
      oldSession: SessionNoConnection,
      connPromise: Promise<ConnType>,
      listeners: SessionConnectingListeners,
    ): SessionConnecting<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      oldSession._handleStateExit();

      const session = new SessionConnecting(
        connPromise,
        listeners,
        ...carriedState,
      );
      session.log?.info(
        'session transition from NoConnection to Connecting',
        session.loggingMetadata,
      );
      return session;
    },
    ConnectingToHandshaking<ConnType extends Connection>(
      oldSession: SessionConnecting<ConnType>,
      conn: ConnType,
      listeners: SessionHandshakingListeners,
    ): SessionHandshaking<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      oldSession._handleStateExit();

      const session = new SessionHandshaking(conn, listeners, ...carriedState);
      session.log?.info(
        'session transition from Connecting to Handshaking',
        session.loggingMetadata,
      );

      return session;
    },
    HandshakingToConnected<ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
      listeners: SessionConnectedListeners,
    ): SessionConnected<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      const conn = oldSession.conn;
      oldSession._handleStateExit();

      const session = new SessionConnected(conn, listeners, ...carriedState);
      session.log?.info(
        'session transition from Handshaking to Connected',
        session.loggingMetadata,
      );

      return session;
    },
    PendingIdentificationToConnected<ConnType extends Connection>(
      pendingSession: SessionPendingIdentification<ConnType>,
      oldSession: SessionNoConnection | undefined,
      sessionId: string,
      to: TransportClientId,
      propagationCtx: PropagationContext | undefined,
      listeners: SessionConnectedListeners,
    ): SessionConnected<ConnType> {
      const conn = pendingSession.conn;
      const { from, options } = pendingSession;
      const carriedState: ConstructorParameters<typeof IdentifiedSession> =
        oldSession
          ? // old session exists, inherit state
            inheritSharedSession(oldSession)
          : // old session does not exist, create new state
            [
              sessionId,
              from,
              to,
              0,
              0,
              [],
              createSessionTelemetryInfo(sessionId, to, from, propagationCtx),
              options,
              pendingSession.log,
            ];

      pendingSession._handleStateExit();
      oldSession?._handleStateExit();

      const session = new SessionConnected(conn, listeners, ...carriedState);
      session.log?.info(
        'session transition from PendingIdentification to Connected',
        session.loggingMetadata,
      );

      return session;
    },
    // disconnect paths
    ConnectingToNoConnection<ConnType extends Connection>(
      oldSession: SessionConnecting<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.bestEffortClose();
      oldSession._handleStateExit();

      const session = new SessionNoConnection(listeners, ...carriedState);
      session.log?.info(
        'session transition from Connecting to NoConnection',
        session.loggingMetadata,
      );

      return session;
    },
    HandshakingToNoConnection<ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.conn.close();
      oldSession._handleStateExit();

      const session = new SessionNoConnection(listeners, ...carriedState);
      session.log?.info(
        'session transition from Handshaking to NoConnection',
        session.loggingMetadata,
      );

      return session;
    },
    ConnectedToNoConnection<ConnType extends Connection>(
      oldSession: SessionConnected<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.conn.close();
      oldSession._handleStateExit();

      const session = new SessionNoConnection(listeners, ...carriedState);
      session.log?.info(
        'session transition from Connected to NoConnection',
        session.loggingMetadata,
      );

      return session;
    },
  },
} as const;
