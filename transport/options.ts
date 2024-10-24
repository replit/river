import { NaiveJsonCodec } from '../codec/json';
import { ConnectionRetryOptions } from './rateLimit';
import { SessionOptions } from './sessionStateMachine/common';

export type TransportOptions = SessionOptions;

export type ProvidedTransportOptions = Partial<TransportOptions>;

export const defaultTransportOptions: TransportOptions = {
  heartbeatIntervalMs: 1_000,
  heartbeatsUntilDead: 2,
  sessionDisconnectGraceMs: 5_000,
  connectionTimeoutMs: 2_000,
  handshakeTimeoutMs: 1_000,
  enableTransparentSessionReconnects: true,
  maxPayloadSizeBytes: 4 * 1024 * 1024,
  codec: NaiveJsonCodec,
};

export type ClientTransportOptions = TransportOptions & ConnectionRetryOptions;

export type ProvidedClientTransportOptions = Partial<ClientTransportOptions>;

const defaultConnectionRetryOptions: ConnectionRetryOptions = {
  baseIntervalMs: 150,
  maxJitterMs: 200,
  maxBackoffMs: 32_000,
  attemptBudgetCapacity: 5,
  budgetRestoreIntervalMs: 200,
};

export const defaultClientTransportOptions: ClientTransportOptions = {
  ...defaultTransportOptions,
  ...defaultConnectionRetryOptions,
};

export type ServerTransportOptions = TransportOptions;

export type ProvidedServerTransportOptions = Partial<ServerTransportOptions>;

export const defaultServerTransportOptions: ServerTransportOptions = {
  ...defaultTransportOptions,
};
