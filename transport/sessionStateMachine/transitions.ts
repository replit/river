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
  };
}

/*
 * Session state machine:
 * 1. SessionNoConnection is the client entrypoint as
 *    we know who the other side is already, we just need to connect
 * 5. SessionWaitingForHandshake is the server entrypoint
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
 * 5. WaitingForHandshake    │  handshake failure  ─────┤      │
 * │  handshake success      ▼                          │      │ connection drop
 * ├───────────────────────► 4. SessionConnected        │      │ heartbeat misses
 * │                         │  invalid message  ───────┼──────┘
 * │                         ▼                          │
 * └───────────────────────► x. Destroy Session   ◄─────┘
 *   handshake failure
 */
export const SessionStateGraph = {
  entrypoints: {
    NoConnection(
      to: TransportClientId,
      from: TransportClientId,
      listeners: SessionNoConnectionListeners,
      options: SessionOptions,
      log?: Logger,
    ) {
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
        log,
      });

      session.log?.info(`session ${session.id} created in NoConnection state`, {
        ...session.loggingMetadata,
        tags: ['state-transition'],
      });

      return session;
    },
    WaitingForHandshake<ConnType extends Connection>(
      from: TransportClientId,
      conn: ConnType,
      listeners: SessionHandshakingListeners,
      options: SessionOptions,
      log?: Logger,
    ): SessionWaitingForHandshake<ConnType> {
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
    NoConnectionToConnecting<ConnType extends Connection>(
      oldSession: SessionNoConnection,
      connPromise: Promise<ConnType>,
      listeners: SessionConnectingListeners,
    ): SessionConnecting<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      oldSession._handleStateExit();

      const session = new SessionConnecting({
        connPromise,
        listeners,
        ...carriedState,
      });
      session.log?.info(
        `session ${session.id} transition from NoConnection to Connecting`,
        {
          ...session.loggingMetadata,
          tags: ['state-transition'],
        },
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
    HandshakingToConnected<ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
      listeners: SessionConnectedListeners,
    ): SessionConnected<ConnType> {
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
    WaitingForHandshakeToConnected<ConnType extends Connection>(
      pendingSession: SessionWaitingForHandshake<ConnType>,
      oldSession: SessionNoConnection | undefined,
      sessionId: string,
      to: TransportClientId,
      propagationCtx: PropagationContext | undefined,
      listeners: SessionConnectedListeners,
    ): SessionConnected<ConnType> {
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
    ConnectingToNoConnection<ConnType extends Connection>(
      oldSession: SessionConnecting<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection {
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
    HandshakingToNoConnection<ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection {
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
    ConnectedToNoConnection<ConnType extends Connection>(
      oldSession: SessionConnected<ConnType>,
      listeners: SessionNoConnectionListeners,
    ): SessionNoConnection {
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
