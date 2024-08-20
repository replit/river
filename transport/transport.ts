import {
  OpaqueTransportMessage,
  PartialTransportMessage,
  TransportClientId,
} from './message';
import {
  BaseLogger,
  LogFn,
  Logger,
  LoggingLevel,
  createLogProxy,
} from '../logging/log';
import { EventDispatcher, EventHandler, EventMap, EventTypes } from './events';
import {
  ProvidedTransportOptions,
  TransportOptions,
  defaultTransportOptions,
} from './options';
import {
  SessionConnected,
  SessionConnecting,
  SessionHandshaking,
  SessionNoConnection,
  SessionState,
} from './sessionStateMachine';
import { Connection } from './connection';
import { Session, SessionStateGraph } from './sessionStateMachine/transitions';
import { SessionId } from './sessionStateMachine/common';

/**
 * Represents the possible states of a transport.
 * @property {'open'} open - The transport is open and operational (note that this doesn't mean it is actively connected)
 * @property {'closed'} closed - The transport is permanently closed and cannot be reopened.
 */
export type TransportStatus = 'open' | 'closed';

export interface DeleteSessionOptions {
  unhealthy: boolean;
}

export type SessionBoundSendFn = (
  msg: PartialTransportMessage,
) => string | undefined;

/**
 * Transports manage the lifecycle (creation/deletion) of sessions
 *
 * ```plaintext
 *            ▲
 *  incoming  │
 *  messages  │
 *            ▼
 *      ┌─────────────┐   1:N   ┌───────────┐   1:1*  ┌────────────┐
 *      │  Transport  │ ◄─────► │  Session  │ ◄─────► │ Connection │
 *      └─────────────┘         └───────────┘         └────────────┘
 *            ▲                               * (may or may not be initialized yet)
 *            │
 *            ▼
 *      ┌───────────┐
 *      │ Message   │
 *      │ Listeners │
 *      └───────────┘
 * ```
 * @abstract
 */
export abstract class Transport<ConnType extends Connection> {
  /**
   * The status of the transport.
   */
  private status: TransportStatus;

  /**
   * The client ID of this transport.
   */
  clientId: TransportClientId;

  /**
   * The event dispatcher for handling events of type EventTypes.
   */
  eventDispatcher: EventDispatcher<EventTypes>;

  /**
   * The options for this transport.
   */
  protected options: TransportOptions;
  log?: Logger;

  sessions: Map<TransportClientId, Session<ConnType>>;

  /**
   * Creates a new Transport instance.
   * @param codec The codec used to encode and decode messages.
   * @param clientId The client ID of this transport.
   */
  constructor(
    clientId: TransportClientId,
    providedOptions?: ProvidedTransportOptions,
  ) {
    this.options = { ...defaultTransportOptions, ...providedOptions };
    this.eventDispatcher = new EventDispatcher();
    this.clientId = clientId;
    this.status = 'open';
    this.sessions = new Map();
  }

  bindLogger(fn: LogFn | Logger, level?: LoggingLevel) {
    // construct logger from fn
    if (typeof fn === 'function') {
      this.log = createLogProxy(new BaseLogger(fn, level));
      return;
    }

    // object case, just assign
    this.log = createLogProxy(fn);
  }

  /**
   * Called when a message is received by this transport.
   * You generally shouldn't need to override this in downstream transport implementations.
   * @param message The received message.
   */
  protected handleMsg(message: OpaqueTransportMessage) {
    if (this.getStatus() !== 'open') return;
    this.eventDispatcher.dispatchEvent('message', message);
  }

  /**
   * Adds a listener to this transport.
   * @param the type of event to listen for
   * @param handler The message handler to add.
   */
  addEventListener<K extends EventTypes, T extends EventHandler<K>>(
    type: K,
    handler: T,
  ): void {
    this.eventDispatcher.addEventListener(type, handler);
  }

  /**
   * Removes a listener from this transport.
   * @param the type of event to un-listen on
   * @param handler The message handler to remove.
   */
  removeEventListener<K extends EventTypes, T extends EventHandler<K>>(
    type: K,
    handler: T,
  ): void {
    this.eventDispatcher.removeEventListener(type, handler);
  }

  protected protocolError(message: EventMap['protocolError']) {
    this.eventDispatcher.dispatchEvent('protocolError', message);
  }

  /**
   * Default close implementation for transports. You should override this in the downstream
   * implementation if you need to do any additional cleanup and call super.close() at the end.
   * Closes the transport. Any messages sent while the transport is closed will be silently discarded.
   */
  close() {
    this.status = 'closed';

    for (const session of this.sessions.values()) {
      this.deleteSession(session);
    }

    this.eventDispatcher.dispatchEvent('transportStatus', {
      status: this.status,
    });

    this.eventDispatcher.removeAllListeners();
    this.log?.info(`manually closed transport`, { clientId: this.clientId });
  }

  getStatus(): TransportStatus {
    return this.status;
  }

  // state transitions
  protected createSession<S extends Session<ConnType>>(session: S): void {
    const activeSession = this.sessions.get(session.to);
    if (activeSession) {
      const msg = `attempt to create session for ${session.to} but active session (${activeSession.id}) already exists`;
      this.log?.error(msg, {
        ...session.loggingMetadata,
        tags: ['invariant-violation'],
      });
      throw new Error(msg);
    }

    this.sessions.set(session.to, session);
    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'connect',
      session: session,
    });

    this.eventDispatcher.dispatchEvent('sessionTransition', {
      state: session.state,
      session: session,
    } as EventMap['sessionTransition']);
  }

  protected updateSession<S extends Session<ConnType>>(session: S): void {
    const activeSession = this.sessions.get(session.to);
    if (!activeSession) {
      const msg = `attempt to transition session for ${session.to} but no active session exists`;
      this.log?.error(msg, {
        ...session.loggingMetadata,
        tags: ['invariant-violation'],
      });
      throw new Error(msg);
    }

    if (activeSession.id !== session.id) {
      const msg = `attempt to transition active session for ${session.to} but active session (${activeSession.id}) is different from handle (${session.id})`;
      this.log?.error(msg, {
        ...session.loggingMetadata,
        tags: ['invariant-violation'],
      });
      throw new Error(msg);
    }

    this.sessions.set(session.to, session);
    this.eventDispatcher.dispatchEvent('sessionTransition', {
      state: session.state,
      session: session,
    } as EventMap['sessionTransition']);
  }

  protected deleteSession(
    session: Session<ConnType>,
    options?: DeleteSessionOptions,
  ) {
    // ensure idempotency esp re: dispatching events
    if (session._isConsumed) return;

    const loggingMetadata = session.loggingMetadata;
    if (loggingMetadata.tags && options?.unhealthy) {
      loggingMetadata.tags.push('unhealthy-session');
    }

    session.log?.info(`closing session ${session.id}`, loggingMetadata);
    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'disconnect',
      session: session,
    });

    const to = session.to;
    session.close();
    this.sessions.delete(to);
  }

  // common listeners
  protected onSessionGracePeriodElapsed(session: Session<ConnType>) {
    this.log?.warn(
      `session to ${session.to} grace period elapsed, closing`,
      session.loggingMetadata,
    );

    this.deleteSession(session);
  }

  protected onConnectingFailed(
    session: SessionConnecting<ConnType>,
  ): SessionNoConnection {
    // transition to no connection
    const noConnectionSession =
      SessionStateGraph.transition.ConnectingToNoConnection(session, {
        onSessionGracePeriodElapsed: () => {
          this.onSessionGracePeriodElapsed(noConnectionSession);
        },
      });

    this.updateSession(noConnectionSession);
    return noConnectionSession;
  }

  protected onConnClosed(
    session: SessionHandshaking<ConnType> | SessionConnected<ConnType>,
  ): SessionNoConnection {
    // transition to no connection
    let noConnectionSession: SessionNoConnection;
    if (session.state === SessionState.Handshaking) {
      noConnectionSession =
        SessionStateGraph.transition.HandshakingToNoConnection(session, {
          onSessionGracePeriodElapsed: () => {
            this.onSessionGracePeriodElapsed(noConnectionSession);
          },
        });
    } else {
      noConnectionSession =
        SessionStateGraph.transition.ConnectedToNoConnection(session, {
          onSessionGracePeriodElapsed: () => {
            this.onSessionGracePeriodElapsed(noConnectionSession);
          },
        });
    }

    this.updateSession(noConnectionSession);
    return noConnectionSession;
  }

  /**
   * Gets a send closure scoped to a specific session. Sending using the returned
   * closure after the session has transitioned to a different state will be a noop.
   *
   * Session objects themselves can become stale as they transition between
   * states. As stale sessions cannot be used again (and will throw), holding
   * onto a session object is not recommended.
   */
  getSessionBoundSendFn(
    to: TransportClientId,
    sessionId: SessionId,
  ): SessionBoundSendFn {
    if (this.getStatus() !== 'open') {
      throw new Error('cannot get a bound send function on a closed transport');
    }

    return (msg: PartialTransportMessage) => {
      const session = this.sessions.get(to);
      if (!session) return;

      const sameSession = session.id === sessionId;
      if (!sameSession) return;

      return session.send(msg);
    };
  }
}
