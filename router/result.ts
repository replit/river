import {
  TLiteral,
  TNever,
  TObject,
  TSchema,
  TString,
  TUnion,
  Type,
} from '@sinclair/typebox';
import { Client } from './client';

type TLiteralString = TLiteral<string>;

export type RiverErrorSchema =
  | TObject<{
      code: TLiteralString | TUnion<Array<TLiteralString>>;
      message: TLiteralString | TString;
    }>
  | TObject<{
      code: TLiteralString | TUnion<Array<TLiteralString>>;
      message: TLiteralString | TString;
      extras: TSchema;
    }>;

export type RiverError =
  | TUnion<Array<RiverErrorSchema>>
  | RiverErrorSchema
  | TNever;

export const UNCAUGHT_ERROR = 'UNCAUGHT_ERROR';
export const UNEXPECTED_DISCONNECT = 'UNEXPECTED_DISCONNECT';
export const RiverUncaughtSchema = Type.Object({
  code: Type.Union([
    Type.Literal(UNCAUGHT_ERROR),
    Type.Literal(UNEXPECTED_DISCONNECT),
  ]),
  message: Type.String(),
});

export type Result<T, E> =
  | {
      ok: true;
      payload: T;
    }
  | {
      ok: false;
      payload: E;
    };

export function Ok<const T, const E>(payload: T): Result<T, E> {
  return {
    ok: true,
    payload,
  };
}

export function Err<const T, const E>(error: E): Result<T, E> {
  return {
    ok: false,
    payload: error,
  };
}

/**
 * Refine a {@link Result} type to its returned value.
 */
export type ResultOk<R> = R extends Result<infer __T, infer __E> & {
  ok: true;
  payload: infer A;
}
  ? A
  : never;

/**
 * Refine a {@link Result} type to its error value.
 */
export type ResultErr<R> = R extends Result<infer __T, infer __E> & {
  ok: false;
  payload: infer A;
}
  ? A
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
      ? Awaited<ReturnType<UploadHandler>> extends [
          infer __UploadInputMessage,
          infer UploadOutputMessage,
        ]
        ? Awaited<UploadOutputMessage>
        : never
      : Procedure extends object & { stream: infer StreamHandler extends Fn }
      ? Awaited<ReturnType<StreamHandler>> extends [
          infer __StreamInputMessage,
          AsyncGenerator<infer StreamOutputMessage>,
          infer __StreamCloseHandle,
        ]
        ? StreamOutputMessage
        : never
      : Procedure extends object & {
          subscribe: infer SubscriptionHandler extends Fn;
        }
      ? Awaited<ReturnType<SubscriptionHandler>> extends [
          AsyncGenerator<infer SubscriptionOutputMessage>,
          infer __SubscriptionCloseHandle,
        ]
        ? SubscriptionOutputMessage
        : never
      : never
    : never
  : never;
