import {
  Static,
  TLiteral,
  TObject,
  TSchema,
  TString,
  TUnion,
  Type,
} from '@sinclair/typebox';
import { Client } from './client';
import { Readable } from './streams';

type TLiteralString = TLiteral<string>;

export type BaseErrorSchemaType =
  | TObject<{
      code: TLiteralString | TUnion<Array<TLiteralString>>;
      message: TLiteralString | TString;
    }>
  | TObject<{
      code: TLiteralString | TUnion<Array<TLiteralString>>;
      message: TLiteralString | TString;
      extras: TSchema;
    }>;

/**
 * Takes in a specific error schema and returns a result schema the error
 */
export const ErrResultSchema = <T extends BaseErrorSchemaType>(t: T) =>
  Type.Object({
    ok: Type.Literal(false),
    payload: t,
  });

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
export interface ErrResult<Err extends Static<BaseErrorSchemaType>> {
  ok: false;
  payload: Err;
}
export type Result<T, Err extends Static<BaseErrorSchemaType>> =
  | OkResult<T>
  | ErrResult<Err>;

export function Ok<const T extends Array<unknown>>(p: T): OkResult<T>;
export function Ok<const T extends ReadonlyArray<unknown>>(p: T): OkResult<T>;
export function Ok<const T>(payload: T): OkResult<T>;
export function Ok<const T>(payload: T): OkResult<T> {
  return {
    ok: true,
    payload,
  };
}

export function Err<const Err extends Static<BaseErrorSchemaType>>(
  error: Err,
): ErrResult<Err> {
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
export function unwrap<T, Err extends Static<BaseErrorSchemaType>>(
  result: Result<T, Err>,
): T {
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
    ? Procedure extends object & { rpc: infer RpcFn extends Fn }
      ? Awaited<ReturnType<RpcFn>>
      : Procedure extends object & { upload: infer UploadFn extends Fn }
      ? ReturnType<UploadFn> extends {
          finalize: (...args: never) => Promise<infer UploadOutputMessage>;
        }
        ? UploadOutputMessage
        : never
      : Procedure extends object & { stream: infer StreamFn extends Fn }
      ? ReturnType<StreamFn> extends {
          resReadable: Readable<
            infer StreamOutputMessage,
            Static<BaseErrorSchemaType>
          >;
        }
        ? StreamOutputMessage
        : never
      : Procedure extends object & {
          subscribe: infer SubscriptionFn extends Fn;
        }
      ? Awaited<ReturnType<SubscriptionFn>> extends {
          resReadable: Readable<
            infer SubscriptionOutputMessage,
            Static<BaseErrorSchemaType>
          >;
        }
        ? SubscriptionOutputMessage
        : never
      : never
    : never
  : never;
