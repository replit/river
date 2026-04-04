export { Transport } from './transport';
export { ClientTransport } from './client';
export { ServerTransport } from './server';
export type { TransportStatus } from './transport';
export type {
  ProvidedTransportOptions as TransportOptions,
  ProvidedClientTransportOptions as ClientTransportOptions,
  ProvidedServerTransportOptions as ServerTransportOptions,
} from './options';
export {
  Session,
  SessionState,
} from './session';
// Backward compat type aliases - all session states are now the same Session class
export type { Session as SessionNoConnection } from './session';
export type { Session as SessionConnecting } from './session';
export type { Session as SessionHandshaking } from './session';
export type { Session as SessionConnected } from './session';
export type { Session as SessionWaitingForHandshake } from './session';
export { Connection } from './connection';
export {
  WebSocketCloseError,
  WebSocketConnection,
} from './impls/ws/connection';
export {
  TransportMessageSchema,
  OpaqueTransportMessageSchema,
} from './message';
export type {
  TransportMessage,
  OpaqueTransportMessage,
  TransportClientId,
  isStreamOpen,
  isStreamClose,
} from './message';
export {
  EventMap,
  EventTypes,
  EventHandler,
  ProtocolError,
  type ProtocolErrorType,
} from './events';
