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
import {
  EventDispatcher,
  EventHandler,
  EventMap,
  EventTypes,
} from './events';
import {
  ProvidedTransportOptions,
  TransportOptions,
  defaultTransportOptions,
} from './options';
import { Session } from './session';
import { Connection } from './connection';
import { Tracer } from '@opentelemetry/api';
import { getTracer } from '../tracing';
import { createScope } from 'effection';
import type { Scope, Task, Future } from 'effection';

/**
 * Represents the possible states of a transport.
 */
export type TransportStatus = 'open' | 'closed';

export interface DeleteSessionOptions {
  unhealthy: boolean;
}

export type SessionBoundSendFn = (msg: PartialTransportMessage) => string;

/**
 * Transports manage the lifecycle (creation/deletion) of sessions.
 *
 * In the Effection architecture, each transport owns an Effection scope.
 * Session lifecycle tasks (connection, handshake, heartbeat, reconnection)
 * run as operations within this scope. When the transport is closed,
 * the scope is destroyed, halting all session tasks.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export abstract class Transport<ConnType extends Connection> {
  private status: TransportStatus;
  clientId: TransportClientId;
  eventDispatcher: EventDispatcher<EventTypes>;
  protected options: TransportOptions;
  log?: Logger;
  tracer: Tracer;

  sessions: Map<TransportClientId, Session>;

  // Effection scope for managing session lifecycle tasks
  protected scope: Scope;
  private destroyScope: () => Future<void>;
  protected sessionTasks: Map<TransportClientId, Task<void>>;

  constructor(
    clientId: TransportClientId,
    providedOptions?: ProvidedTransportOptions,
  ) {
    this.options = { ...defaultTransportOptions, ...providedOptions };
    this.eventDispatcher = new EventDispatcher();
    this.clientId = clientId;
    this.status = 'open';
    this.sessions = new Map();
    this.tracer = getTracer();

    // Create Effection scope for this transport's lifecycle
    [this.scope, this.destroyScope] = createScope();
    this.sessionTasks = new Map();
  }

  bindLogger(fn: LogFn | Logger, level?: LoggingLevel) {
    if (typeof fn === 'function') {
      this.log = createLogProxy(new BaseLogger(fn, level));
      return;
    }
    this.log = createLogProxy(fn);
  }

  protected handleMsg(message: OpaqueTransportMessage) {
    if (this.getStatus() !== 'open') return;
    this.eventDispatcher.dispatchEvent('message', message);
  }

  addEventListener<K extends EventTypes, T extends EventHandler<K>>(
    type: K,
    handler: T,
  ): void {
    this.eventDispatcher.addEventListener(type, handler);
  }

  removeEventListener<K extends EventTypes, T extends EventHandler<K>>(
    type: K,
    handler: T,
  ): void {
    this.eventDispatcher.removeEventListener(type, handler);
  }

  protected protocolError(message: EventMap['protocolError']) {
    this.eventDispatcher.dispatchEvent('protocolError', message);
  }

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

    // Destroy Effection scope - halts all session tasks
    void this.destroyScope();
  }

  getStatus(): TransportStatus {
    return this.status;
  }

  protected createSessionEntry(session: Session): void {
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

  protected dispatchSessionTransition(session: Session): void {
    this.eventDispatcher.dispatchEvent('sessionTransition', {
      state: session.state,
      id: session.id,
    } as EventMap['sessionTransition']);
  }

  protected deleteSession(
    session: Session,
    options?: DeleteSessionOptions,
  ) {
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

    // Halt the Effection task managing this session
    const task = this.sessionTasks.get(to);
    if (task) {
      void task.halt();
      this.sessionTasks.delete(to);
    }

    this.eventDispatcher.dispatchEvent('sessionStatus', {
      status: 'closed',
      session: { id: session.id, to: to },
    });
  }

  /**
   * Gets a send closure scoped to a specific session.
   */
  getSessionBoundSendFn(
    to: TransportClientId,
    sessionId: string,
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
}
