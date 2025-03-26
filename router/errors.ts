import {
  Kind,
  Static,
  TLiteral,
  TNever,
  TObject,
  TSchema,
  TString,
  TUnion,
  Type,
} from '@sinclair/typebox';
import { ValueErrorIterator } from '@sinclair/typebox/errors';

/**
 * {@link UNCAUGHT_ERROR_CODE} is the code that is used when an error is thrown
 * inside a procedure handler that's not required.
 */
export const UNCAUGHT_ERROR_CODE = 'UNCAUGHT_ERROR';
/**
 * {@link UNEXPECTED_DISCONNECT_CODE} is the code used the stream's session
 * disconnect unexpetedly.
 */
export const UNEXPECTED_DISCONNECT_CODE = 'UNEXPECTED_DISCONNECT';
/**
 * {@link INVALID_REQUEST_CODE} is the code used when a client's request is invalid.
 */
export const INVALID_REQUEST_CODE = 'INVALID_REQUEST';
/**
 * {@link CANCEL_CODE} is the code used when either server or client cancels the stream.
 */
export const CANCEL_CODE = 'CANCEL';

type TLiteralString = TLiteral<string>;

export type BaseErrorSchemaType =
  | TObject<{
      code: TLiteralString;
      message: TLiteralString | TString;
    }>
  | TObject<{
      code: TLiteralString;
      message: TLiteralString | TString;
      extras: TSchema;
    }>;

/**
 * Takes in a specific error schema and returns a result schema the error
 */
export const ErrResultSchema = <T extends ProcedureErrorSchemaType>(t: T) =>
  Type.Object({
    ok: Type.Literal(false),
    payload: t,
  });

const ValidationErrorDetails = Type.Object({
  path: Type.String(),
  message: Type.String(),
});

export const ValidationErrors = Type.Array(ValidationErrorDetails);
export function castTypeboxValueErrors(
  errors: ValueErrorIterator,
): Static<typeof ValidationErrors> {
  const result = [];
  for (const error of errors) {
    result.push({
      path: error.path,
      message: error.message,
    });
  }

  return result;
}

/**
 * A schema for cancel payloads sent from the client
 */
export const CancelResultSchema = Type.Object({
  code: Type.Literal(CANCEL_CODE),
  message: Type.String(),
});

/**
 * {@link ReaderErrorSchema} is the schema for all the built-in river errors that
 * can be emitted to a reader (request reader on the server, and response reader
 * on the client).
 */
export const ReaderErrorSchema = Type.Union([
  Type.Object({
    code: Type.Literal(UNCAUGHT_ERROR_CODE),
    message: Type.String(),
  }),
  Type.Object({
    code: Type.Literal(UNEXPECTED_DISCONNECT_CODE),
    message: Type.String(),
  }),
  Type.Object({
    code: Type.Literal(INVALID_REQUEST_CODE),
    message: Type.String(),
    extras: Type.Optional(
      Type.Object({
        firstValidationErrors: Type.Array(ValidationErrorDetails),
        totalErrors: Type.Number(),
      }),
    ),
  }),
  CancelResultSchema,
]) satisfies ProcedureErrorSchemaType;

/**
 * Represents an acceptable schema to pass to a procedure.
 * Just a type of a schema, not an actual schema.
 *
 */
export type ProcedureErrorSchemaType =
  | TNever
  | BaseErrorSchemaType
  | TUnion<Array<BaseErrorSchemaType>>;

// arbitrarily nested unions
// river doesn't accept this by default, use the `flattenErrorType` helper
type NestableProcedureErrorSchemaType =
  | BaseErrorSchemaType
  | TUnion<NestableProcedureErrorSchemaTypeArray>;

// use an interface to defer the type definition to be evaluated lazily
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface NestableProcedureErrorSchemaTypeArray
  extends Array<NestableProcedureErrorSchemaType> {}

function isUnion(schema: TSchema): schema is TUnion {
  return schema[Kind] === 'Union';
}

type Flatten<T> = T extends BaseErrorSchemaType
  ? T
  : T extends TUnion<Array<infer U extends TSchema>>
  ? Flatten<U>
  : unknown;

/**
 * In the case where API consumers for some god-forsaken reason want to use
 * arbitrarily nested unions, this helper flattens them to a single level.
 *
 * Note that loses some metadata information on the nested unions like
 * nested description fields, etc.
 *
 * @param errType - An arbitrarily union-nested error schema.
 * @returns The flattened error schema.
 */
export function flattenErrorType<T extends NestableProcedureErrorSchemaType>(
  errType: T,
): Flatten<T>;
export function flattenErrorType(
  errType: NestableProcedureErrorSchemaType,
): ProcedureErrorSchemaType {
  if (!isUnion(errType)) {
    return errType;
  }

  const flattenedTypes: Array<BaseErrorSchemaType> = [];
  function flatten(type: NestableProcedureErrorSchemaType) {
    if (isUnion(type)) {
      for (const t of type.anyOf) {
        flatten(t);
      }
    } else {
      flattenedTypes.push(type);
    }
  }

  flatten(errType);

  return Type.Union(flattenedTypes);
}
