import { nanoid } from 'nanoid';
import { OpaqueTransportMessage, TransportClientId } from '..';
import { Connection, SessionOptions } from '../session';
import { SessionConnecting } from './SessionConnecting';
import { SessionNoConnection } from './SessionNoConnection';
import {
  IdentifiedSession,
  SessionConnectedListeners,
  SessionConnectingListeners,
  SessionHandshakingListeners,
  bestEffortClose,
} from './common';
import { createSessionTelemetryInfo } from '../../tracing';
import { SessionPendingIdentification } from './SessionPendingIdentification';
import { SessionHandshaking } from './SessionHandshaking';
import { SessionConnected } from './SessionConnected';

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

export const SessionStateMachine = {
  entrypoints: {
    NoConnection(
      to: TransportClientId,
      from: TransportClientId,
      options: SessionOptions,
    ) {
      const id = `session-${nanoid(12)}`;
      const telemetry = createSessionTelemetryInfo(id, to, from);
      const sendBuffer: Array<OpaqueTransportMessage> = [];

      return new SessionNoConnection(
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
      oldSession._onStateExit();

      return new SessionConnecting(connPromise, listeners, ...carriedState);
    },
    ConnectingToHandshaking<ConnType extends Connection>(
      oldSession: SessionConnecting<ConnType>,
      conn: ConnType,
      listeners: SessionHandshakingListeners,
    ): SessionHandshaking<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      oldSession._onStateExit();

      return new SessionHandshaking(conn, listeners, ...carriedState);
    },
    HandshakingToConnected<ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
      listeners: SessionConnectedListeners,
    ): SessionConnected<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      const conn = oldSession.conn;
      oldSession._onStateExit();

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
      oldSession._onStateExit();

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
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      bestEffortClose(oldSession.connPromise);
      oldSession._onStateExit();
      return new SessionNoConnection(...carriedState);
    },
    HandshakingToNoConnection<ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.conn.close();
      oldSession._onStateExit();
      return new SessionNoConnection(...carriedState);
    },
    ConnectedToNoConnection<ConnType extends Connection>(
      oldSession: SessionConnected<ConnType>,
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.conn.close();
      oldSession._onStateExit();
      return new SessionNoConnection(...carriedState);
    },
  },
} as const;
