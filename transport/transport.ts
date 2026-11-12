import {
  type BuiltInHandshakeErrorCode,
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
import {
  EventDispatcher,
  EventHandler,
  EventMap,
  EventTypes,
  ProtocolError,
} from './events';
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
  SessionNoConnectionListeners,
  SessionState,
} from './sessionStateMachine';
import { Connection } from './connection';
import { Session, SessionStateGraph } from './sessionStateMachine/transitions';
import { SessionBackingOff } from './sessionStateMachine/SessionBackingOff';
import { SessionId } from './sessionStateMachine/common';
import { Tracer } from '@opentelemetry/api';
import { getTracer } from '../tracing';

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Represents the possible states of a transport.
 * @property {'open'} open - The transport is open and operational (note that this doesn't mean it is actively connected)
 * @property {'closed'} closed - The transport is permanently closed and cannot be reopened.
 */
export type TransportStatus = 'open' | 'closed';

export interface DeleteSessionOptions {
  unhealthy: boolean;
}

export type SessionBoundSendFn = (msg: PartialTransportMessage) => string;

/**
 * Advisory backpressure accessors scoped to a specific session,
 * see {@link Transport.getSessionBackpressure}.
 */
export interface SessionBackpressure {
  isSendBufferFull: () => boolean;
  waitForSendBufferDrain: () => Promise<void>;
}

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
export abstract class Transport<
  ConnType extends Connection,
  HandshakeFailureCode extends string = BuiltInHandshakeErrorCode,
> {
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
  eventDispatcher: EventDispatcher<EventTypes, HandshakeFailureCode>;

  /**
   * The options for this transport.
   */
  protected options: TransportOptions;
  log?: Logger;
  tracer: Tracer;

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
    const streamMark = this.options.streamSendBufferHighWaterMark;
    if (
      streamMark !== undefined &&
      (!Number.isSafeInteger(streamMark) || streamMark < 1)
    ) {
      throw new Error(
        'streamSendBufferHighWaterMark must be a positive integer',
      );
    }
    const receiverAck = this.options.receiverAck;
    if (
      receiverAck &&
      (!Number.isSafeInteger(receiverAck.maxMessages) ||
        receiverAck.maxMessages < 1 ||
        !Number.isFinite(receiverAck.maxDelayMs) ||
        receiverAck.maxDelayMs <= 0 ||
        receiverAck.maxDelayMs > MAX_TIMER_DELAY_MS)
    ) {
      throw new Error('receiverAck requires positive message and delay limits');
    }
    this.eventDispatcher = new EventDispatcher<
      EventTypes,
      HandshakeFailureCode
    >();
    this.clientId = clientId;
    this.status = 'open';
    this.sessions = new Map();
    this.tracer = getTracer();
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
  addEventListener<
    K extends EventTypes,
    T extends EventHandler<K, HandshakeFailureCode>,
  >(type: K, handler: T): void {
    this.eventDispatcher.addEventListener(type, handler);
  }

  /**
   * Removes a listener from this transport.
   * @param the type of event to un-listen on
   * @param handler The message handler to remove.
   */
  removeEventListener<
    K extends EventTypes,
    T extends EventHandler<K, HandshakeFailureCode>,
  >(type: K, handler: T): void {
    this.eventDispatcher.removeEventListener(type, handler);
  }

  protected protocolError(
    message: EventMap<HandshakeFailureCode>['protocolError'],
  ) {
    this.eventDispatcher.dispatchEvent('protocolError', message);
  }

  /**
   * Default close implementation for transports. You should override this in the downstream
   * implementation if you need to do any additional cleanup and call super.close() at the end.
   * Closes the transport. Any messages sent while the transport is closed will be silently discarded.
   */
  close() {
    this.status = 'closed';

    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
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
      status: 'created',
      session: session,
    });

    this.eventDispatcher.dispatchEvent('sessionTransition', {
      state: session.state,
      id: session.id,
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
      id: session.id,
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
      status: 'closing',
      session: session,
    });

    const to = session.to;
    session.close();
    this.sessions.delete(to);
    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'closed',
      session: { id: session.id, to: to },
    });
  }

  // common listeners
  protected onSessionGracePeriodElapsed(session: Session<ConnType>) {
    this.log?.info(
      `session to ${session.to} grace period elapsed, closing`,
      session.loggingMetadata,
    );

    this.deleteSession(session);
  }

  private noConnectionListeners(
    getSession: () => SessionNoConnection,
  ): SessionNoConnectionListeners {
    return {
      onSessionGracePeriodElapsed: () => {
        this.onSessionGracePeriodElapsed(getSession());
      },
      onMessageSendFailure: (msg, reason) => {
        const session = getSession();
        this.log?.error(`failed to send message: ${reason}`, {
          ...session.loggingMetadata,
          transportMessage: msg,
        });

        this.protocolError({
          type: ProtocolError.MessageSendFailure,
          message: reason,
        });
        this.deleteSession(session, { unhealthy: true });
      },
    };
  }

  protected onBackoffCancelled(session: SessionBackingOff) {
    // transition to no connection
    const noConnectionSession: SessionNoConnection =
      SessionStateGraph.transition.BackingOffToNoConnection(
        session,
        this.noConnectionListeners(() => noConnectionSession),
      );

    this.updateSession(noConnectionSession);
  }

  protected onConnectingFailed(
    session: SessionConnecting<ConnType>,
  ): SessionNoConnection {
    // transition to no connection
    const noConnectionSession: SessionNoConnection =
      SessionStateGraph.transition.ConnectingToNoConnection(
        session,
        this.noConnectionListeners(() => noConnectionSession),
      );

    this.updateSession(noConnectionSession);

    return noConnectionSession;
  }

  protected onConnClosed(
    session: SessionHandshaking<ConnType> | SessionConnected<ConnType>,
  ): SessionNoConnection {
    // transition to no connection
    let noConnectionSession: SessionNoConnection;
    const listeners = this.noConnectionListeners(() => noConnectionSession);

    if (session.state === SessionState.Handshaking) {
      noConnectionSession =
        SessionStateGraph.transition.HandshakingToNoConnection(
          session,
          listeners,
        );
    } else {
      noConnectionSession =
        SessionStateGraph.transition.ConnectedToNoConnection(
          session,
          listeners,
        );
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
      if (!session) {
        throw new Error(
          `session scope for ${sessionId} has ended (close), can't send`,
        );
      }

      const sameSession = session.id === sessionId;
      if (!sameSession || session._isConsumed) {
        throw new Error(
          `session scope for ${sessionId} has ended (transition), can't send`,
        );
      }

      const res = session.send(msg);
      if (!res.ok) {
        throw new Error(res.reason);
      }

      return res.value;
    };
  }

  /**
   * Gets advisory backpressure accessors scoped to a specific session, for
   * use by {@link Writable}s writing to that session. Unlike
   * {@link getSessionBoundSendFn}, these never throw once the session scope
   * has ended — they report "not full" / resolve immediately instead, since
   * the writable is torn down separately via session status events.
   */
  getSessionBackpressure(
    to: TransportClientId,
    sessionId: SessionId,
    streamId?: string,
  ): SessionBackpressure {
    const currentSession = () => {
      const session = this.sessions.get(to);
      if (!session || session.id !== sessionId || session._isConsumed) {
        return undefined;
      }

      return session;
    };

    return {
      isSendBufferFull: () =>
        currentSession()?.isSendBufferFull(streamId) ?? false,
      waitForSendBufferDrain: () =>
        currentSession()?.waitForSendBufferDrain(streamId) ?? Promise.resolve(),
    };
  }
}
