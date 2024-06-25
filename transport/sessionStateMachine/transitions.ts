import { nanoid } from 'nanoid';
import { OpaqueTransportMessage, TransportClientId } from '..';
import { Connection, SessionOptions } from '../session';
import {
  SessionConnecting,
  SessionConnectingListeners,
} from './SessionConnecting';
import {
  SessionNoConnection,
  SessionNoConnectionListeners,
} from './SessionNoConnection';
import { IdentifiedSession } from './common';
import { createSessionTelemetryInfo } from '../../tracing';
import { SessionPendingIdentification } from './SessionPendingIdentification';
import {
  SessionHandshaking,
  SessionHandshakingListeners,
} from './SessionHandshaking';
import {
  SessionConnected,
  SessionConnectedListeners,
} from './SessionConnected';

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
      const id = `session-${nanoid(12)}`;
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
      listeners: SessionConnectingListeners<ConnType>,
    ): SessionConnecting<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      oldSession._handleStateExit();

      return new SessionConnecting(connPromise, listeners, ...carriedState);
    },
    ConnectingToHandshaking<ConnType extends Connection>(
      oldSession: SessionConnecting<ConnType>,
      conn: ConnType,
      listeners: SessionHandshakingListeners,
    ): SessionHandshaking<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      oldSession._handleStateExit();

      return new SessionHandshaking(conn, listeners, ...carriedState);
    },
    HandshakingToConnected<ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
      listeners: SessionConnectedListeners,
    ): SessionConnected<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      const conn = oldSession.conn;
      oldSession._handleStateExit();

      return new SessionConnected(conn, listeners, ...carriedState);
    },
    PendingIdentificationToConnected<ConnType extends Connection>(
      oldSession: SessionPendingIdentification<ConnType>,
      sessionId: string,
      to: TransportClientId,
      listeners: SessionConnectedListeners,
    ): SessionConnected<ConnType> {
      const conn = oldSession.conn;
      const { from, options } = oldSession;
      oldSession._handleStateExit();

      const telemetry = createSessionTelemetryInfo(sessionId, to, from);
      return new SessionConnected(
        conn,
        listeners,
        sessionId,
        from,
        to,
        0,
        0,
        [],
        telemetry,
        options,
      );
    },
    // disconnect paths
    ConnectingToNoConnection<ConnType extends Connection>(
      oldSession: SessionConnecting<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.bestEffortClose();
      oldSession._handleStateExit();
      return new SessionNoConnection(listeners, ...carriedState);
    },
    HandshakingToNoConnection<ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.conn.close();
      oldSession._handleStateExit();
      return new SessionNoConnection(listeners, ...carriedState);
    },
    ConnectedToNoConnection<ConnType extends Connection>(
      oldSession: SessionConnected<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.conn.close();
      oldSession._handleStateExit();
      return new SessionNoConnection(listeners, ...carriedState);
    },
  },
} as const;
