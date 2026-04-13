import {
  CANCEL_CODE,
  INVALID_REQUEST_CODE,
  UNCAUGHT_ERROR_CODE,
  UNEXPECTED_DISCONNECT_CODE,
} from '../router/errors';
import { type ErrResult, type ErrorPayload } from '../router/result';

/**
 * Canonical RPC error codes shared by gRPC and Connect.
 *
 * The protobuf router uses these codes for unary rejections and streamed error
 * messages so applications can reason about familiar transport-agnostic error
 * categories.
 */
export enum RiverErrorCode {
  OK = 'OK',
  CANCELED = 'CANCELED',
  UNKNOWN = 'UNKNOWN',
  INVALID_ARGUMENT = 'INVALID_ARGUMENT',
  DEADLINE_EXCEEDED = 'DEADLINE_EXCEEDED',
  NOT_FOUND = 'NOT_FOUND',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  RESOURCE_EXHAUSTED = 'RESOURCE_EXHAUSTED',
  FAILED_PRECONDITION = 'FAILED_PRECONDITION',
  ABORTED = 'ABORTED',
  OUT_OF_RANGE = 'OUT_OF_RANGE',
  UNIMPLEMENTED = 'UNIMPLEMENTED',
  INTERNAL = 'INTERNAL',
  UNAVAILABLE = 'UNAVAILABLE',
  DATA_LOSS = 'DATA_LOSS',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
}

/**
 * Protocol-level error codes surfaced by River itself rather than user
 * handlers.
 */
export type ProtocolErrorCode =
  | typeof CANCEL_CODE
  | typeof INVALID_REQUEST_CODE
  | typeof UNCAUGHT_ERROR_CODE
  | typeof UNEXPECTED_DISCONNECT_CODE;

/**
 * Error codes visible from the protobuf client surface.
 */
export type ClientErrorCode = RiverErrorCode | ProtocolErrorCode;

const riverErrorCodeSet = new Set<string>(Object.values(RiverErrorCode));
const protocolErrorCodeSet = new Set<string>([
  CANCEL_CODE,
  INVALID_REQUEST_CODE,
  UNCAUGHT_ERROR_CODE,
  UNEXPECTED_DISCONNECT_CODE,
]);

/**
 * A serialized protobuf error detail.
 *
 * The `typeName` identifies the protobuf message descriptor the client can use
 * to decode `value`.
 */
export interface RiverErrorDetail {
  readonly typeName: string;
  readonly value: Uint8Array;
}

/**
 * A plain-object error payload used by the protobuf router.
 *
 * Handlers return these via `Err({ code, message, ... })`.
 */
export interface ClientError extends ErrorPayload {
  readonly code: ClientErrorCode;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly details?: ReadonlyArray<RiverErrorDetail>;
}

/**
 * A protocol error emitted by the River runtime.
 */
export interface ProtocolError extends ClientError {
  readonly code: ProtocolErrorCode;
}

/**
 * Returns true when the given value matches the wire shape of a client error
 * with a canonical RPC error code.
 */
export function isRiverError(value: unknown): value is ClientError {
  if (!(typeof value === 'object' && value !== null)) {
    return false;
  }

  const candidate = value as Partial<ClientError>;

  return (
    isRiverErrorCode(candidate.code) && typeof candidate.message === 'string'
  );
}

/**
 * Returns true when the given value is a protocol error.
 */
export function isProtocolError(value: unknown): value is ProtocolError {
  if (!(typeof value === 'object' && value !== null)) {
    return false;
  }

  const candidate = value as Partial<ProtocolError>;

  return (
    isProtocolErrorCode(candidate.code) && typeof candidate.message === 'string'
  );
}

/**
 * Returns true when the given value is any client-visible error.
 */
export function isClientError(value: unknown): value is ClientError {
  return isRiverError(value) || isProtocolError(value);
}

/**
 * Returns true when the given value matches the `Err(...)` wrapper used for
 * protobuf cancel payloads sent by the runtime or handlers.
 */
export function isSerializedClientErrorResult(
  value: unknown,
): value is ErrResult<ClientError> {
  return isErrResultWithPayload(value, isClientError);
}

/**
 * Returns true when the given value matches the protocol-only cancel payloads
 * sent by clients.
 */
export function isSerializedProtocolErrorResult(
  value: unknown,
): value is ErrResult<ProtocolError> {
  return isErrResultWithPayload(value, isProtocolError);
}

// -- internal helpers --

function isRiverErrorCode(value: unknown): value is RiverErrorCode {
  return typeof value === 'string' && riverErrorCodeSet.has(value);
}

function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && protocolErrorCodeSet.has(value);
}

function isErrResultWithPayload<T extends ErrorPayload>(
  value: unknown,
  predicate: (payload: unknown) => payload is T,
): value is ErrResult<T> {
  if (!(typeof value === 'object' && value !== null)) {
    return false;
  }

  const candidate = value as { ok?: unknown; payload?: unknown };

  return candidate.ok === false && predicate(candidate.payload);
}
