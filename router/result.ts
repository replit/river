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
import { ReadStream } from './streams';

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
export const INVALID_REQUEST = 'INVALID_REQUEST';
export const RiverUncaughtSchema = Type.Object({
  code: Type.Union([
    Type.Literal(UNCAUGHT_ERROR),
    Type.Literal(UNEXPECTED_DISCONNECT),
    Type.Literal(INVALID_REQUEST),
  ]),
  message: Type.String(),
});

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

interface OkResult<T> {
  ok: true;
  payload: T;
}
interface ErrResult<Err> {
  ok: false;
  payload: Err;
}
export type Result<T, Err> = OkResult<T> | ErrResult<Err>;

export function Ok<const T extends Array<unknown>>(p: T): OkResult<T>;
export function Ok<const T extends ReadonlyArray<unknown>>(p: T): OkResult<T>;
export function Ok<const T>(payload: T): OkResult<T>;
export function Ok<const T>(payload: T): OkResult<T> {
  return {
    ok: true,
    payload,
  };
}

export function Err<const Err>(error: Err): ErrResult<Err> {
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
          ReadStream<infer StreamOutputMessage>,
        ]
        ? StreamOutputMessage
        : never
      : Procedure extends object & {
          subscribe: infer SubscriptionHandler extends Fn;
        }
      ? Awaited<ReturnType<SubscriptionHandler>> extends ReadStream<
          infer SubscriptionOutputMessage
        >
        ? SubscriptionOutputMessage
        : never
      : never
    : never
  : never;
