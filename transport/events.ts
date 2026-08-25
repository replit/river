import { Connection } from './connection';
import type {
  BuiltInHandshakeErrorCode,
  OpaqueTransportMessage,
} from './message';
import { Session, SessionState } from './sessionStateMachine';
import { SessionId } from './sessionStateMachine/common';
import { TransportStatus } from './transport';

export const ProtocolError = {
  RetriesExceeded: 'conn_retry_exceeded',
  HandshakeFailed: 'handshake_failed',
  MessageOrderingViolated: 'message_ordering_violated',
  InvalidMessage: 'invalid_message',
  MessageSendFailure: 'message_send_failure',
} as const;

export type ProtocolErrorType =
  (typeof ProtocolError)[keyof typeof ProtocolError];

/**
 * Transport events. `HandshakeFailureCode` is the full set of codes observable
 * on handshake-failed protocol errors, including built-in and custom codes.
 */
export interface EventMap<
  HandshakeFailureCode extends string = BuiltInHandshakeErrorCode,
> {
  message: OpaqueTransportMessage;
  sessionStatus:
    | {
        status: 'created' | 'closing';
        session: Session<Connection>;
      }
    | {
        status: 'closed';
        session: Pick<Session<Connection>, 'id' | 'to'>;
      };
  sessionTransition:
    | { state: SessionState.Connected; id: SessionId }
    | { state: SessionState.Handshaking; id: SessionId }
    | { state: SessionState.Connecting; id: SessionId }
    | { state: SessionState.BackingOff; id: SessionId }
    | { state: SessionState.NoConnection; id: SessionId };
  protocolError:
    | {
        type: (typeof ProtocolError)['HandshakeFailed'];
        code: HandshakeFailureCode;
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
export type EventHandler<
  K extends EventTypes,
  HandshakeFailureCode extends string = BuiltInHandshakeErrorCode,
> = (event: EventMap<HandshakeFailureCode>[K]) => unknown;

export class EventDispatcher<
  T extends EventTypes,
  HandshakeFailureCode extends string,
> {
  private eventListeners: {
    [K in T]?: Set<EventHandler<K, HandshakeFailureCode>>;
  } = {};

  removeAllListeners() {
    this.eventListeners = {};
  }

  numberOfListeners<K extends T>(eventType: K) {
    return this.eventListeners[eventType]?.size ?? 0;
  }

  addEventListener<K extends T>(
    eventType: K,
    handler: EventHandler<K, HandshakeFailureCode>,
  ) {
    if (!this.eventListeners[eventType]) {
      this.eventListeners[eventType] = new Set();
    }

    this.eventListeners[eventType].add(handler);
  }

  removeEventListener<K extends T>(
    eventType: K,
    handler: EventHandler<K, HandshakeFailureCode>,
  ) {
    const handlers = this.eventListeners[eventType];
    if (handlers) {
      this.eventListeners[eventType]?.delete(handler);
    }
  }

  dispatchEvent<K extends T>(
    eventType: K,
    event: EventMap<HandshakeFailureCode>[K],
  ) {
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
