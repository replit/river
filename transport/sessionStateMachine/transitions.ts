import { OpaqueTransportMessage, TransportClientId } from '..';
import {
  SessionConnecting,
  SessionConnectingListeners,
} from './SessionConnecting';
import {
  SessionNoConnection,
  SessionNoConnectionListeners,
} from './SessionNoConnection';
import {
  IdentifiedSession,
  IdentifiedSessionProps,
  SessionOptions,
} from './common';
import { PropagationContext, createSessionTelemetryInfo } from '../../tracing';
import { SessionWaitingForHandshake } from './SessionWaitingForHandshake';
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
import { Logger } from '../../logging';
import {
  SessionBackingOff,
  SessionBackingOffListeners,
} from './SessionBackingOff';

function inheritSharedSession(
  session: IdentifiedSession,
): IdentifiedSessionProps {
  return {
    id: session.id,
    from: session.from,
    to: session.to,
    seq: session.seq,
    ack: session.ack,
    sendBuffer: session.sendBuffer,
    telemetry: session.telemetry,
    options: session.options,
    log: session.log,
    protocolVersion: session.protocolVersion,
  };
}

export const SessionStateGraph = {
  entrypoints: {
    NoConnection: (
      to: TransportClientId,
      from: TransportClientId,
      listeners: SessionNoConnectionListeners,
      options: SessionOptions,
      protocolVersion: string,
      log?: Logger,
    ) => {
      const id = `session-${generateId()}`;
      const telemetry = createSessionTelemetryInfo(id, to, from);
      const sendBuffer: Array<OpaqueTransportMessage> = [];

      const session = new SessionNoConnection({
        listeners,
        id,
        from,
        to,
        seq: 0,
        ack: 0,
        sendBuffer,
        telemetry,
        options,
        protocolVersion,
        log,
      });

      session.log?.info(`session ${session.id} created in NoConnection state`, {
        ...session.loggingMetadata,
        tags: ['state-transition'],
      });

      return session;
    },
    WaitingForHandshake: <ConnType extends Connection>(
      from: TransportClientId,
      conn: ConnType,
      listeners: SessionHandshakingListeners,
      options: SessionOptions,
      log?: Logger,
    ): SessionWaitingForHandshake<ConnType> => {
      const session = new SessionWaitingForHandshake({
        conn,
        listeners,
        from,
        options,
        log,
      });

      session.log?.info(`session created in WaitingForHandshake state`, {
        ...session.loggingMetadata,
        tags: ['state-transition'],
      });

      return session;
    },
  },
  // All of the transitions 'move'/'consume' the old session and return a new one.
  // After a session is transitioned, any usage of the old session will throw.
  transition: {
    // happy path transitions
    NoConnectionToBackingOff: (
      oldSession: SessionNoConnection,
      backoffMs: number,
      listeners: SessionBackingOffListeners,
    ): SessionBackingOff => {
      const carriedState = inheritSharedSession(oldSession);
      oldSession._handleStateExit();

      const session = new SessionBackingOff({
        backoffMs,
        listeners,
        ...carriedState,
      });

      session.log?.info(
        `session ${session.id} transition from NoConnection to BackingOff`,
        {
          ...session.loggingMetadata,
          tags: ['state-transition'],
        },
      );
      return session;
    },
    BackingOffToConnecting: <ConnType extends Connection>(
      oldSession: SessionBackingOff,
      connPromise: Promise<ConnType>,
      listeners: SessionConnectingListeners,
    ): SessionConnecting<ConnType> => {
      const carriedState = inheritSharedSession(oldSession);
      oldSession._handleStateExit();

      const session = new SessionConnecting({
        connPromise,
        listeners,
        ...carriedState,
      });

      session.log?.info(
        `session ${session.id} transition from BackingOff to Connecting`,
        {
          ...session.loggingMetadata,
          tags: ['state-transition'],
        },
      );
      return session;
    },
    ConnectingToHandshaking: <ConnType extends Connection>(
      oldSession: SessionConnecting<ConnType>,
      conn: ConnType,
      listeners: SessionHandshakingListeners,
    ): SessionHandshaking<ConnType> => {
      const carriedState = inheritSharedSession(oldSession);
      oldSession._handleStateExit();

      const session = new SessionHandshaking({
        conn,
        listeners,
        ...carriedState,
      });

      session.log?.info(
        `session ${session.id} transition from Connecting to Handshaking`,
        {
          ...session.loggingMetadata,
          tags: ['state-transition'],
        },
      );

      return session;
    },
    HandshakingToConnected: <ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
      listeners: SessionConnectedListeners,
    ): SessionConnected<ConnType> => {
      const carriedState = inheritSharedSession(oldSession);
      const conn = oldSession.conn;
      oldSession._handleStateExit();

      const session = new SessionConnected({
        conn,
        listeners,
        ...carriedState,
      });

      session.log?.info(
        `session ${session.id} transition from Handshaking to Connected`,
        {
          ...session.loggingMetadata,
          tags: ['state-transition'],
        },
      );

      return session;
    },
    WaitingForHandshakeToConnected: <ConnType extends Connection>(
      pendingSession: SessionWaitingForHandshake<ConnType>,
      oldSession: SessionNoConnection | undefined,
      sessionId: string,
      to: TransportClientId,
      propagationCtx: PropagationContext | undefined,
      listeners: SessionConnectedListeners,
      protocolVersion: string,
    ): SessionConnected<ConnType> => {
      const conn = pendingSession.conn;
      const { from, options } = pendingSession;
      const carriedState: IdentifiedSessionProps = oldSession
        ? // old session exists, inherit state
          inheritSharedSession(oldSession)
        : // old session does not exist, create new state
          {
            id: sessionId,
            from,
            to,
            seq: 0,
            ack: 0,
            sendBuffer: [],
            telemetry: createSessionTelemetryInfo(
              sessionId,
              to,
              from,
              propagationCtx,
            ),
            options,
            log: pendingSession.log,
            protocolVersion,
          };

      pendingSession._handleStateExit();
      oldSession?._handleStateExit();

      const session = new SessionConnected({
        conn,
        listeners,
        ...carriedState,
      });
      session.log?.info(
        `session ${session.id} transition from WaitingForHandshake to Connected`,
        {
          ...session.loggingMetadata,
          tags: ['state-transition'],
        },
      );

      return session;
    },
    // disconnect paths
    BackingOffToNoConnection: (
      oldSession: SessionBackingOff,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection => {
      const carriedState = inheritSharedSession(oldSession);
      oldSession._handleStateExit();

      const session = new SessionNoConnection({ listeners, ...carriedState });
      session.log?.info(
        `session ${session.id} transition from BackingOff to NoConnection`,
        {
          ...session.loggingMetadata,
          tags: ['state-transition'],
        },
      );

      return session;
    },
    ConnectingToNoConnection: <ConnType extends Connection>(
      oldSession: SessionConnecting<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection => {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.bestEffortClose();
      oldSession._handleStateExit();

      const session = new SessionNoConnection({ listeners, ...carriedState });
      session.log?.info(
        `session ${session.id} transition from Connecting to NoConnection`,
        {
          ...session.loggingMetadata,
          tags: ['state-transition'],
        },
      );

      return session;
    },
    HandshakingToNoConnection: <ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection => {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.conn.close();
      oldSession._handleStateExit();

      const session = new SessionNoConnection({ listeners, ...carriedState });
      session.log?.info(
        `session ${session.id} transition from Handshaking to NoConnection`,
        {
          ...session.loggingMetadata,
          tags: ['state-transition'],
        },
      );

      return session;
    },
    ConnectedToNoConnection: <ConnType extends Connection>(
      oldSession: SessionConnected<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection => {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.conn.close();
      oldSession._handleStateExit();

      const session = new SessionNoConnection({ listeners, ...carriedState });
      session.log?.info(
        `session ${session.id} transition from Connected to NoConnection`,
        {
          ...session.loggingMetadata,
          tags: ['state-transition'],
        },
      );

      return session;
    },
  },
} as const;

const transitions = SessionStateGraph.transition;

/*
 * 0. SessionNoConnection         ◄──┐
 * │  reconnect / connect attempt    │
 * ▼                                 │
 * 1. SessionBackingOff              │
 * │                              ───┤ explicit close
 * ▼                                 │
 * 2. SessionConnecting              │
 * │  connect success  ──────────────┤ connect failure
 * ▼                                 │
 * 3. SessionHandshaking             │
 * │  handshake success       ┌──────┤ connection drop
 * │  handshake failure  ─────┤      │
 * ▼                          │      │ connection drop
 * 4. SessionConnected        │      │ heartbeat misses
 * │  invalid message  ───────┼──────┘
 * ▼                          │
 * x. Destroy Session   ◄─────┘
 */
export const ClientSessionStateGraph = {
  entrypoint: SessionStateGraph.entrypoints.NoConnection,
  transition: {
    // happy paths
    NoConnectionToBackingOff: transitions.NoConnectionToBackingOff,
    BackingOffToConnecting: transitions.BackingOffToConnecting,
    ConnectingToHandshaking: transitions.ConnectingToHandshaking,
    HandshakingToConnected: transitions.HandshakingToConnected,
    // disconnect paths
    BackingOffToNoConnection: transitions.BackingOffToNoConnection,
    ConnectingToNoConnection: transitions.ConnectingToNoConnection,
    HandshakingToNoConnection: transitions.HandshakingToNoConnection,
    ConnectedToNoConnection: transitions.ConnectedToNoConnection,
  },
};

export type ClientSession<ConnType extends Connection> =
  | SessionNoConnection
  | SessionBackingOff
  | SessionConnecting<ConnType>
  | SessionHandshaking<ConnType>
  | SessionConnected<ConnType>;

/*
 * 0. SessionNoConnection         ◄──┐
 * │  reconnect / connect attempt    │
 * ▼                                 │
 * 1. WaitingForHandshake            │
 * │  handshake success       ┌──────┤ connection drop
 * │  handshake failure  ─────┤      │
 * ▼                          │      │ connection drop
 * 2. SessionConnected        │      │ heartbeat misses
 * │  invalid message  ───────┼──────┘
 * ▼                          │
 * x. Destroy Session   ◄─────┘
 */
export const ServerSessionStateGraph = {
  entrypoint: SessionStateGraph.entrypoints.WaitingForHandshake,
  transition: {
    // happy paths
    WaitingForHandshakeToConnected: transitions.WaitingForHandshakeToConnected,
    // disconnect paths
    ConnectedToNoConnection: transitions.ConnectedToNoConnection,
  },
};

export type ServerSession<ConnType extends Connection> =
  // SessionWaitingForHandshake<ConnType> is stored separately in the server transport
  SessionConnected<ConnType> | SessionNoConnection;

export type Session<ConnType extends Connection> =
  | ClientSession<ConnType>
  | ServerSession<ConnType>;
