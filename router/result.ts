import { Type } from '@sinclair/typebox';
import { Client } from './client';
import { ReadStream } from './streams';

export interface BaseError {
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}

/**
 * AnyResultSchema is a schema to validate any result.
 */
export const AnyResultSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(false),
    payload: Type.Object({
      code: Type.String(),
      message: Type.String(),
      extras: Type.Optional(Type.Unknown()),
    }),
  }),

  Type.Object({
    ok: Type.Literal(true),
    payload: Type.Unknown(),
  }),
]);

export interface OkResult<T> {
  ok: true;
  payload: T;
}
export interface ErrResult<Err extends BaseError> {
  ok: false;
  payload: Err;
}
export type Result<T, Err extends BaseError> = OkResult<T> | ErrResult<Err>;

export function Ok<const T extends Array<unknown>>(p: T): OkResult<T>;
export function Ok<const T extends ReadonlyArray<unknown>>(p: T): OkResult<T>;
export function Ok<const T>(payload: T): OkResult<T>;
export function Ok<const T>(payload: T): OkResult<T> {
  return {
    ok: true,
    payload,
  };
}

export function Err<const Err extends BaseError>(error: Err): ErrResult<Err> {
  return {
    ok: false,
    payload: error,
  };
}

/**
 * Refine a {@link Result} type to its returned payload.
 */
export type ResultUnwrapOk<R> = R extends Result<infer T, infer __E>
  ? T
  : never;

/**
 * Unwrap a {@link Result} type and return the payload if successful,
 * otherwise throws an error.
 * @param result - The result to unwrap.
 * @throws Will throw an error if the result is not ok.
 */
export function unwrap<T, Err extends BaseError>(result: Result<T, Err>): T {
  if (result.ok) {
    return result.payload;
  }

  throw new Error(
    `Cannot non-ok result, got: ${result.payload.code} - ${result.payload.message}`,
  );
}

/**
 * Refine a {@link Result} type to its error payload.
 */
export type ResultUnwrapErr<R> = R extends Result<infer __T, infer Err>
  ? Err
  : never;

/**
 * Retrieve the output type for a procedure, represented as a {@link Result}
 * type.
 * Example:
 * ```
 * type Message = Output<typeof client, 'serviceName', 'procedureName'>
 * ```
 */
export type Output<
  RiverClient,
  ServiceName extends keyof RiverClient,
  ProcedureName extends keyof RiverClient[ServiceName],
  Procedure = RiverClient[ServiceName][ProcedureName],
  Fn extends (...args: never) => unknown = (...args: never) => unknown,
> = RiverClient extends Client<infer __ServiceSchemaMap>
  ? Procedure extends object
    ? Procedure extends object & { rpc: infer RpcHandler extends Fn }
      ? Awaited<ReturnType<RpcHandler>>
      : Procedure extends object & { upload: infer UploadHandler extends Fn }
      ? ReturnType<UploadHandler> extends [
          infer __UploadInputMessage,
          (...args: never) => Promise<infer UploadOutputMessage>,
        ]
        ? UploadOutputMessage
        : never
      : Procedure extends object & { stream: infer StreamHandler extends Fn }
      ? ReturnType<StreamHandler> extends [
          infer __StreamInputMessage,
          ReadStream<infer StreamOutputMessage, BaseError>,
        ]
        ? StreamOutputMessage
        : never
      : Procedure extends object & {
          subscribe: infer SubscriptionHandler extends Fn;
        }
      ? Awaited<ReturnType<SubscriptionHandler>> extends ReadStream<
          infer SubscriptionOutputMessage,
          BaseError
        >
        ? SubscriptionOutputMessage
        : never
      : never
    : never
  : never;
