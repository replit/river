import { Type } from '@sinclair/typebox';

export const UNCAUGHT_ERROR = 'UNCAUGHT_ERROR';
export const RiverUncaughtSchema = Type.Object({
  code: Type.Literal(UNCAUGHT_ERROR),
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

export function Ok<T, E>(payload: T): Result<T, E> {
  return {
    ok: true,
    payload,
  };
}

export function Err<T, E>(error: E): Result<T, E> {
  return {
    ok: false,
    payload: error,
  };
}
