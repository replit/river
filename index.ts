export { serializeService, ServiceBuilder } from './router/builder';
export type {
  ValidProcType,
  ProcListing,
  Service,
  ProcHandler,
  ProcInput,
  ProcOutput,
  ProcType,
  Procedure,
} from './router/builder';

export { createClient } from './router/client';
export type { ServerClient } from './router/client';

export { createServer } from './router/server';
export { asClientRpc, asClientStream } from './router/server.util';
export type { Server } from './router/server';
export type { ServiceContext, ServiceContextWithState } from './router/context';

export { Transport } from './transport/types';
export {
  TransportMessageSchema,
  OpaqueTransportMessageSchema,
  TransportAckSchema,
  msg,
  payloadToTransportMessage,
  ack,
  reply,
} from './transport/message';
export type {
  TransportMessage,
  MessageId,
  OpaqueTransportMessage,
  TransportClientId,
  TransportMessageAck,
} from './transport/message';

export { StreamTransport } from './transport/stream';
export { WebSocketTransport } from './transport/ws';
export {
  createWebSocketServer,
  onServerReady,
  createWsTransports,
  waitForMessage,
  createLocalWebSocketClient,
} from './transport/util';
