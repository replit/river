import { OpaqueTransportMessage } from './message';
import { Connection, Session } from './session';

type ConnectionStatus = 'connect' | 'disconnect';
export const ProtocolError = {
  RetriesExceeded: 'conn_retry_exceeded',
  HandshakeFailed: 'handshake_failed',
  UseAfterDestroy: 'use_after_destroy',
} as const;
export type ProtocolErrorType =
  (typeof ProtocolError)[keyof typeof ProtocolError];

export interface EventMap {
  message: OpaqueTransportMessage;
  connectionStatus: {
    status: ConnectionStatus;
    conn: Connection;
  };
  sessionStatus: {
    status: ConnectionStatus;
    session: Session<Connection>;
  };
  protocolError: {
    type: ProtocolErrorType;
    message: string;
  };
}

export type EventTypes = keyof EventMap;
export type EventHandler<K extends EventTypes> = (
  event: EventMap[K],
) => unknown;

export class EventDispatcher<T extends EventTypes> {
  private eventListeners: { [K in T]?: Set<EventHandler<K>> } = {};

  numberOfListeners<K extends T>(eventType: K) {
    return this.eventListeners[eventType]?.size ?? 0;
  }

  addEventListener<K extends T>(eventType: K, handler: EventHandler<K>) {
    if (!this.eventListeners[eventType]) {
      this.eventListeners[eventType] = new Set();
    }

    this.eventListeners[eventType]?.add(handler);
  }

  removeEventListener<K extends T>(eventType: K, handler: EventHandler<K>) {
    const handlers = this.eventListeners[eventType];
    if (handlers) {
      this.eventListeners[eventType]?.delete(handler);
    }
  }

  dispatchEvent<K extends T>(eventType: K, event: EventMap[K]) {
    const handlers = this.eventListeners[eventType];
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }
  }
}
