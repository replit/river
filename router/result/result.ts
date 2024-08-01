import { Static, Type } from '@sinclair/typebox';
import { BaseErrorSchemaType } from './errors';

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
