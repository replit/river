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
  SessionNoConnection,
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
 * Transports manage the lifecycle (creation/deletion) of sessions and connections. Its responsibilities include:
 *
 *  1) Constructing a new {@link Session} and {@link Connection} on {@link TransportMessage}s from new clients.
 *     After constructing the {@link Connection}, {@link onConnect} is called which adds it to the connection map.
 *  2) Delegating message listening of the connection to the newly created {@link Connection}.
 *     From this point on, the {@link Connection} is responsible for *reading* and *writing*
 *     messages from the connection.
 *  3) When a connection is closed, the {@link Transport} calls {@link onDisconnect} which closes the
 *     connection via {@link Connection.close} and removes it from the {@link connections} map.

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

  sessions = new Map<TransportClientId, Session<ConnType>>();

  /**
   * Creates a new Transport instance.
   * This should also set up {@link onConnect}, and {@link onDisconnect} listeners.
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
    );

    if (this.log) {
      session.log = this.log;
    }

    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'connect',
      session,
    });

    // invariant check
    // TODO: these shouldn't need to be done
    const existingSession = this.sessions.get(session.to);
    if (existingSession && existingSession !== session) {
      throw new Error('attempt to create session when one already exists');
    }

    this.sessions.set(session.to, session);
    return session;
  }

  protected deleteSession(session: Session<ConnType>) {
    session.close();
    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'disconnect',
      session,
    });

    // invariant check
    // TODO: these shouldn't need to be done
    const existingSession = this.sessions.get(session.to);
    if (existingSession && existingSession !== session) {
      throw new Error('attempt to delete mismatched session');
    }

    this.sessions.delete(session.to);
  }

  // common listeners
  private onSessionGracePeriodElapsed = (session: SessionNoConnection) => {
    this.log?.warn(
      `session to ${session.to} grace period elapsed, closing`,
      session.loggingMetadata,
    );

    this.deleteSession(session);
  };
}
