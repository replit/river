import {
  TLiteral,
  TNever,
  TObject,
  TSchema,
  TString,
  TUnion,
  Type,
} from '@sinclair/typebox';

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
