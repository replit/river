import {
  OpaqueTransportMessage,
  TransportClientId,
  PartialTransportMessage,
} from './message';
import {
  BaseLogger,
  LogFn,
  Logger,
  LoggingLevel,
  createLogProxy,
} from '../logging/log';
import {
  EventDispatcher,
  EventHandler,
  EventMap,
  EventTypes,
  ProtocolErrorType,
} from './events';
import {
  ProvidedTransportOptions,
  TransportOptions,
  defaultTransportOptions,
} from './options';
import {
  Session,
  SessionConnected,
  SessionConnecting,
  SessionHandshaking,
  SessionNoConnection,
  SessionState,
  SessionStateMachine,
} from './sessionStateMachine';
import { Connection } from './connection';

/**
 * Represents the possible states of a transport.
 * @property {'open'} open - The transport is open and operational (note that this doesn't mean it is actively connected)
 * @property {'closed'} closed - The transport is permanently closed and cannot be reopened.
 */
export type TransportStatus = 'open' | 'closed';

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
   * @param msg The received message.
   */
  protected handleMsg(msg: OpaqueTransportMessage) {
    if (this.getStatus() !== 'open') return;
    this.eventDispatcher.dispatchEvent('message', msg);
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

  /**
   * Sends a message over this transport, delegating to the appropriate connection to actually
   * send the message.
   * @param msg The message to send.
   * @returns The ID of the sent message or undefined if it wasn't sent
   */
  send(to: TransportClientId, msg: PartialTransportMessage): string {
    if (this.getStatus() === 'closed') {
      const err = 'transport is closed, cant send';
      this.log?.error(err, {
        clientId: this.clientId,
        transportMessage: msg,
        tags: ['invariant-violation'],
      });

      throw new Error(err);
    }

    let session = this.sessions.get(to);
    if (!session) {
      session = this.createUnconnectedSession(to);
    }

    return session.send(msg);
  }

  protected protocolError(type: ProtocolErrorType, message: string) {
    this.eventDispatcher.dispatchEvent('protocolError', { type, message });
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

  protected updateSession<S extends Session<ConnType>>(session: S): S {
    const activeSession = this.sessions.get(session.to);
    if (activeSession && activeSession.id !== session.id) {
      const msg = `attempt to transition active session for ${session.to} but active session (${activeSession.id}) is different from handle (${session.id})`;
      throw new Error(msg);
    }

    this.sessions.set(session.to, session);

    if (!activeSession) {
      this.eventDispatcher.dispatchEvent('sessionStatus', {
        status: 'connect',
        session: session,
      });
    }

    this.eventDispatcher.dispatchEvent('sessionTransition', {
      state: session.state,
      session: session,
    } as EventMap['sessionTransition']);

    return session;
  }

  // state transitions
  protected createUnconnectedSession(to: string): SessionNoConnection {
    const session = SessionStateMachine.entrypoints.NoConnection(
      to,
      this.clientId,
      {
        onSessionGracePeriodElapsed: () => {
          this.onSessionGracePeriodElapsed(session);
        },
      },
      this.options,
      this.log,
    );

    this.updateSession(session);
    return session;
  }

  protected deleteSession(session: Session<ConnType>) {
    session.log?.info(`closing session ${session.id}`, session.loggingMetadata);

    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'disconnect',
      session: session,
    });

    session.close();
    this.sessions.delete(session.to);
  }

  // common listeners
  protected onSessionGracePeriodElapsed(session: SessionNoConnection) {
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
      SessionStateMachine.transition.ConnectingToNoConnection(session, {
        onSessionGracePeriodElapsed: () => {
          this.onSessionGracePeriodElapsed(noConnectionSession);
        },
      });

    return this.updateSession(noConnectionSession);
  }

  protected onConnClosed(
    session: SessionHandshaking<ConnType> | SessionConnected<ConnType>,
  ): SessionNoConnection {
    // transition to no connection
    let noConnectionSession: SessionNoConnection;
    if (session.state === SessionState.Handshaking) {
      noConnectionSession =
        SessionStateMachine.transition.HandshakingToNoConnection(session, {
          onSessionGracePeriodElapsed: () => {
            this.onSessionGracePeriodElapsed(noConnectionSession);
          },
        });
    } else {
      noConnectionSession =
        SessionStateMachine.transition.ConnectedToNoConnection(session, {
          onSessionGracePeriodElapsed: () => {
            this.onSessionGracePeriodElapsed(noConnectionSession);
          },
        });
    }

    return this.updateSession(noConnectionSession);
  }
}
