import { type Static } from '@sinclair/typebox';
import { Connection } from './connection';
import { HandshakeErrorResponseCodes, OpaqueTransportMessage } from './message';
import { Session, SessionState } from './sessionStateMachine';

/**
 * Represents the possible states of a transport.
 * @property {'open'} open - The transport is open and operational (note that this doesn't mean it is actively connected)
 * @property {'closed'} closed - The transport is permanently closed and cannot be reopened.
 */
export type TransportStatus = 'open' | 'closed';

export const ProtocolError = {
  RetriesExceeded: 'conn_retry_exceeded',
  HandshakeFailed: 'handshake_failed',
  MessageOrderingViolated: 'message_ordering_violated',
  InvalidMessage: 'invalid_message',
} as const;

export type ProtocolErrorType =
  (typeof ProtocolError)[keyof typeof ProtocolError];

export interface EventMap {
  message: OpaqueTransportMessage;
  sessionStatus: {
    status: 'connect' | 'disconnect';
    session: Session<Connection>;
  };
  sessionTransition:
    | { state: SessionState.Connected }
    | { state: SessionState.Handshaking }
    | { state: SessionState.Connecting }
    | { state: SessionState.BackingOff }
    | { state: SessionState.NoConnection };
  protocolError:
    | {
        type: (typeof ProtocolError)['HandshakeFailed'];
        code: Static<typeof HandshakeErrorResponseCodes>;
        message: string;
      }
    | {
        type: Omit<
          ProtocolErrorType,
          (typeof ProtocolError)['HandshakeFailed']
        >;
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
