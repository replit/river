import { Connection } from './connection';
import { OpaqueTransportMessage } from './message';
import { Session } from './sessionStateMachine';
import { TransportStatus } from './transport';

type ConnectionStatus = 'connect' | 'disconnect';
export const ProtocolError = {
  RetriesExceeded: 'conn_retry_exceeded',
  HandshakeFailed: 'handshake_failed',
  MessageOrderingViolated: 'message_ordering_violated',
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
  transportStatus: {
    status: TransportStatus;
  };
}

export type EventTypes = keyof EventMap;
export type EventHandler<K extends EventTypes> = (
  event: EventMap[K],
) => unknown;

export class EventDispatcher<T extends EventTypes> {
  private eventListeners: { [K in T]?: Set<EventHandler<K>> } = {};

  removeAllListeners() {
    this.eventListeners = {};
  }

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
      // copying ensures that adding more listeners in a handler doesn't
      // affect the current dispatch.
      const copy = [...handlers];
      for (const handler of copy) {
        handler(event);
      }
    }
  }
}
