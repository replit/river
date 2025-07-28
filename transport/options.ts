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

export type ServerTransportOptions = TransportOptions & {
  /**
   * If `true` (the default), then the transport/server will parse input
   * (non-control, user-provided) values strictly, meaning that the input value
   * is expected to match the schema exactly without any processing.
   */
  strictInputParsing: boolean;
};

export type ProvidedServerTransportOptions = Partial<ServerTransportOptions>;

export const defaultServerTransportOptions: ServerTransportOptions = {
  ...defaultTransportOptions,
  strictInputParsing: true,
};
