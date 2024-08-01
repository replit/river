/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import {
  TLiteral,
  TObject,
  TSchema,
  TString,
  TUnion,
  Type,
} from '@sinclair/typebox';

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
 * INTERNAL_RIVER_ERROR_CODE is the code that is used when an internal error occurs,
 * this means that some invariants expected by the river server implementation have
 * been violated. When encountering this error please report this to river maintainers.
 */
export const INTERNAL_RIVER_ERROR_CODE = 'INTERNAL_RIVER_ERROR' as const;
/**
 * UNCAUGHT_ERROR_CODE is the code that is used when an error is thrown
 * inside a procedure handler that's not required.
 */
export const UNCAUGHT_ERROR_CODE = 'UNCAUGHT_ERROR' as const;
/**
 * UNEXPECTED_DISCONNECT_CODE is the code used the stream's session
 * disconnect unexpetedly.
 */
export const UNEXPECTED_DISCONNECT_CODE = 'UNEXPECTED_DISCONNECT' as const;
/**
 * INVALID_REQUEST_CODE is the code used when a client's request is invalid.
 */
export const INVALID_REQUEST_CODE = 'INVALID_REQUEST' as const;
/**
 * ABORT_CODE is the code used when either server or client aborts the stream.
 */
export const ABORT_CODE = 'ABORT' as const;

/**
 * {@link ResponseBuiltinErrorSchema} is the schema for all the errors that can be
 * emitted while reading responses on the client.
 */
export const ResponseBuiltinErrorSchema = Type.Object({
  code: Type.Union([
    Type.Literal(INTERNAL_RIVER_ERROR_CODE),
    Type.Literal(UNCAUGHT_ERROR_CODE),
    Type.Literal(UNEXPECTED_DISCONNECT_CODE),
    Type.Literal(INVALID_REQUEST_CODE),
    Type.Literal(ABORT_CODE),
  ]),
  message: Type.String(),
}) satisfies BaseErrorSchemaType;

/**
 * {@link RequestBuiltInErrorSchema} is the schema for all the errors that can be
 * emitted while reading requests on the server.
 */
export const RequestBuiltInErrorSchema = Type.Object({
  code: Type.Union([
    Type.Literal(UNCAUGHT_ERROR_CODE),
    Type.Literal(UNEXPECTED_DISCONNECT_CODE),
    Type.Literal(INVALID_REQUEST_CODE),
    Type.Literal(ABORT_CODE),
  ]),
  message: Type.String(),
}) satisfies BaseErrorSchemaType;
