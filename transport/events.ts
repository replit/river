import { OpaqueTransportMessage } from './message';
import { Connection } from './transport';

export interface EventMap {
  message: OpaqueTransportMessage;
  connectionStatus: {
    status: 'connect' | 'disconnect';
    conn: Connection;
  };
}

export type EventTypes = keyof EventMap;
export type EventHandler<K extends EventTypes> = (event: EventMap[K]) => void;

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
