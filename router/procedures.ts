/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { Kind, Static, TNever, TSchema, TUnion, Type } from '@sinclair/typebox';
import { ProcedureHandlerContext } from './context';
import { BaseErrorSchemaType, Result } from './result';
import { Readable, Writable } from './streams';

/**
 * Brands a type to prevent it from being directly constructed.
 */
export type Branded<T> = T & { readonly __BRAND_DO_NOT_USE: unique symbol };

/**
 * Unbrands a {@link Branded} type.
 */
export type Unbranded<T> = T extends Branded<infer U> ? U : never;

/**
 * The valid {@link Procedure} types. The `stream` and `upload` types can optionally have a
 * different type for the very first initialization message. The suffixless types correspond to
 * gRPC's four combinations of stream / non-stream in each direction.
 */
export type ValidProcType =
  // Single message in both directions (1:1).
  | 'rpc'
  // Client-stream single message from server (n:1).
  | 'upload'
  // Single message from client, stream from server (1:n).
  | 'subscription'
  // Bidirectional stream (n:n).
  | 'stream';

/**
 * Represents the payload type for {@link Procedure}s.
 */
export type PayloadType = TSchema;

/**
 * {@link UNCAUGHT_ERROR_CODE} is the code that is used when an error is thrown
 * inside a procedure handler that's not required.
 */
export const UNCAUGHT_ERROR_CODE = 'UNCAUGHT_ERROR' as const;
/**
 * {@link UNEXPECTED_DISCONNECT_CODE} is the code used the stream's session
 * disconnect unexpetedly.
 */
export const UNEXPECTED_DISCONNECT_CODE = 'UNEXPECTED_DISCONNECT' as const;
/**
 * {@link INVALID_REQUEST_CODE} is the code used when a client's request is invalid.
 */
export const INVALID_REQUEST_CODE = 'INVALID_REQUEST' as const;
/**
 * {@link CANCEL_CODE} is the code used when either server or client cancels the stream.
 */
export const CANCEL_CODE = 'CANCEL' as const;

/**
 * {@link ReaderErrorSchema} is the schema for all the built-in river errors that
 * can be emitted to a reader (request reader on the server, and response reader
 * on the client).
 */
export const ReaderErrorSchema = Type.Object({
  code: Type.Union([
    Type.Literal(UNCAUGHT_ERROR_CODE),
    Type.Literal(UNEXPECTED_DISCONNECT_CODE),
    Type.Literal(INVALID_REQUEST_CODE),
    Type.Literal(CANCEL_CODE),
  ]),
  message: Type.String(),
});

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
 * arbitrarily nested unions, this helper flattens them to a single level
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

/**
 * Procedure for a single message in both directions (1:1).
 *
 * @template State - The context state object.
 * @template RequestInit - The TypeBox schema of the initialization object.
 * @template ResponseData - The TypeBox schema of the response object.
 * @template ResponseErr - The TypeBox schema of the error object.
 */
export interface RpcProcedure<
  State,
  RequestInit extends PayloadType,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
> {
  type: 'rpc';
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError: ResponseErr;
  description?: string;
  handler(param: {
    ctx: ProcedureHandlerContext<State>;
    reqInit: Static<RequestInit>;
  }): Promise<Result<Static<ResponseData>, Static<ResponseErr>>>;
}

/**
 * Procedure for a client-stream (potentially preceded by an initialization message),
 * single message from server (n:1).
 *
 * @template State - The context state object.
 * @template RequestInit - The TypeBox schema of the initialization object.
 * @template RequestData - The TypeBox schema of the request object.
 * @template ResponseData - The TypeBox schema of the response object.
 * @template ResponseErr - The TypeBox schema of the error object.
 */
export interface UploadProcedure<
  State,
  RequestInit extends PayloadType,
  RequestData extends PayloadType,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
> {
  type: 'upload';
  requestInit: RequestInit;
  requestData: RequestData;
  responseData: ResponseData;
  responseError: ResponseErr;
  description?: string;
  handler(param: {
    ctx: ProcedureHandlerContext<State>;
    reqInit: Static<RequestInit>;
    reqReadable: Readable<
      Static<RequestData>,
      Static<typeof ReaderErrorSchema>
    >;
  }): Promise<Result<Static<ResponseData>, Static<ResponseErr>>>;
}

/**
 * Procedure for a single message from client, stream from server (1:n).
 *
 * @template State - The context state object.
 * @template RequestInit - The TypeBox schema of the initialization object.
 * @template ResponseData - The TypeBox schema of the response object.
 * @template ResponseErr - The TypeBox schema of the error object.
 */
export interface SubscriptionProcedure<
  State,
  RequestInit extends PayloadType,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
> {
  type: 'subscription';
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError: ResponseErr;
  description?: string;
  handler(param: {
    ctx: ProcedureHandlerContext<State>;
    reqInit: Static<RequestInit>;
    resWritable: Writable<Result<Static<ResponseData>, Static<ResponseErr>>>;
  }): Promise<void | undefined>;
}

/**
 * Procedure for a bidirectional stream (potentially preceded by an initialization message),
 * (n:n).
 *
 * @template State - The context state object.
 * @template RequestInit - The TypeBox schema of the initialization object.
 * @template RequestData - The TypeBox schema of the request object.
 * @template ResponseData - The TypeBox schema of the response object.
 * @template ResponseErr - The TypeBox schema of the error object.
 */
export interface StreamProcedure<
  State,
  RequestInit extends PayloadType,
  RequestData extends PayloadType,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
> {
  type: 'stream';
  requestInit: RequestInit;
  requestData: RequestData;
  responseData: ResponseData;
  responseError: ResponseErr;
  description?: string;
  handler(param: {
    ctx: ProcedureHandlerContext<State>;
    reqInit: Static<RequestInit>;
    reqReadable: Readable<
      Static<RequestData>,
      Static<typeof ReaderErrorSchema>
    >;
    resWritable: Writable<Result<Static<ResponseData>, Static<ResponseErr>>>;
  }): Promise<void | undefined>;
}

/**
 * Defines a Procedure type that can be a:
 * - {@link RpcProcedure} for a single message in both directions (1:1)
 * - {@link UploadProcedure} for a client-stream (potentially preceded by an
 *   initialization message)
 * - {@link SubscriptionProcedure} for a single message from client, stream from server (1:n)
 * - {@link StreamProcedure} for a bidirectional stream (potentially preceded by an
 *    initialization message)
 *
 * @template State - The TypeBox schema of the state object.
 * @template Ty - The type of the procedure.
 * @template RequestData - The TypeBox schema of the request object.
 * @template RequestInit - The TypeBox schema of the request initialization object, if any.
 * @template ResponseData - The TypeBox schema of the response object.
 */
export type Procedure<
  State,
  Ty extends ValidProcType,
  RequestInit extends PayloadType,
  RequestData extends PayloadType | null,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
> = { type: Ty } & (RequestData extends PayloadType
  ? Ty extends 'upload'
    ? UploadProcedure<
        State,
        RequestInit,
        RequestData,
        ResponseData,
        ResponseErr
      >
    : Ty extends 'stream'
    ? StreamProcedure<
        State,
        RequestInit,
        RequestData,
        ResponseData,
        ResponseErr
      >
    : never
  : Ty extends 'rpc'
  ? RpcProcedure<State, RequestInit, ResponseData, ResponseErr>
  : Ty extends 'subscription'
  ? SubscriptionProcedure<State, RequestInit, ResponseData, ResponseErr>
  : never);

/**
 * Represents any {@link Procedure} type.
 *
 * @template State - The context state object. You can provide this to constrain
 *                   the type of procedures.
 */
export type AnyProcedure<State = object> = Procedure<
  State,
  ValidProcType,
  PayloadType,
  PayloadType | null,
  PayloadType,
  ProcedureErrorSchemaType
>;

/**
 * Represents a map of {@link Procedure}s.
 *
 * @template State - The context state object. You can provide this to constrain
 *                   the type of procedures.
 */
export type ProcedureMap<State = object> = Record<string, AnyProcedure<State>>;

// typescript is funky so with these upcoming procedure constructors, the overloads
// which handle the `init` case _must_ come first, otherwise the `init` property
// is not recognized as optional, for some reason

/**
 * Creates an {@link RpcProcedure}.
 */
// signature: default errors
function rpc<
  State,
  RequestInit extends PayloadType,
  ResponseData extends PayloadType,
>(def: {
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError?: never;
  description?: string;
  handler: RpcProcedure<State, RequestInit, ResponseData, TNever>['handler'];
}): Branded<RpcProcedure<State, RequestInit, ResponseData, TNever>>;

// signature: explicit errors
function rpc<
  State,
  RequestInit extends PayloadType,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
>(def: {
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError: ResponseErr;
  description?: string;
  handler: RpcProcedure<
    State,
    RequestInit,
    ResponseData,
    ResponseErr
  >['handler'];
}): Branded<RpcProcedure<State, RequestInit, ResponseData, ResponseErr>>;

// implementation
function rpc({
  requestInit,
  responseData,
  responseError = Type.Never(),
  description,
  handler,
}: {
  requestInit: PayloadType;
  responseData: PayloadType;
  responseError?: ProcedureErrorSchemaType;
  description?: string;
  handler: RpcProcedure<
    object,
    PayloadType,
    PayloadType,
    ProcedureErrorSchemaType
  >['handler'];
}) {
  return {
    ...(description ? { description } : {}),
    type: 'rpc',
    requestInit,
    responseData,
    responseError,
    handler,
  };
}

/**
 * Creates an {@link UploadProcedure}, optionally with an initialization message.
 */
// signature: init with default errors
function upload<
  State,
  RequestInit extends PayloadType,
  RequestData extends PayloadType,
  ResponseData extends PayloadType,
>(def: {
  requestInit: RequestInit;
  requestData: RequestData;
  responseData: ResponseData;
  responseError?: never;
  description?: string;
  handler: UploadProcedure<
    State,
    RequestInit,
    RequestData,
    ResponseData,
    TNever
  >['handler'];
}): Branded<
  UploadProcedure<State, RequestInit, RequestData, ResponseData, TNever>
>;

// signature: init with explicit errors
function upload<
  State,
  RequestInit extends PayloadType,
  RequestData extends PayloadType,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
>(def: {
  requestInit: RequestInit;
  requestData: RequestData;
  responseData: ResponseData;
  responseError: ResponseErr;
  description?: string;
  handler: UploadProcedure<
    State,
    RequestInit,
    RequestData,
    ResponseData,
    ResponseErr
  >['handler'];
}): Branded<
  UploadProcedure<State, RequestInit, RequestData, ResponseData, ResponseErr>
>;

// implementation
function upload({
  requestInit,
  requestData,
  responseData,
  responseError = Type.Never(),
  description,
  handler,
}: {
  requestInit: PayloadType;
  requestData: PayloadType;
  responseData: PayloadType;
  responseError?: ProcedureErrorSchemaType;
  description?: string;
  handler: UploadProcedure<
    object,
    PayloadType,
    PayloadType,
    PayloadType,
    ProcedureErrorSchemaType
  >['handler'];
}) {
  return {
    type: 'upload',
    ...(description ? { description } : {}),
    requestInit,
    requestData,
    responseData,
    responseError,
    handler,
  };
}

/**
 * Creates a {@link SubscriptionProcedure}.
 */
// signature: default errors
function subscription<
  State,
  RequestInit extends PayloadType,
  ResponseData extends PayloadType,
>(def: {
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError?: never;
  description?: string;
  handler: SubscriptionProcedure<
    State,
    RequestInit,
    ResponseData,
    TNever
  >['handler'];
}): Branded<SubscriptionProcedure<State, RequestInit, ResponseData, TNever>>;

// signature: explicit errors
function subscription<
  State,
  RequestInit extends PayloadType,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
>(def: {
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError: ResponseErr;
  description?: string;
  handler: SubscriptionProcedure<
    State,
    RequestInit,
    ResponseData,
    ResponseErr
  >['handler'];
}): Branded<
  SubscriptionProcedure<State, RequestInit, ResponseData, ResponseErr>
>;

// implementation
function subscription({
  requestInit,
  responseData,
  responseError = Type.Never(),
  description,
  handler,
}: {
  requestInit: PayloadType;
  responseData: PayloadType;
  responseError?: ProcedureErrorSchemaType;
  description?: string;
  handler: SubscriptionProcedure<
    object,
    PayloadType,
    PayloadType,
    ProcedureErrorSchemaType
  >['handler'];
}) {
  return {
    type: 'subscription',
    ...(description ? { description } : {}),
    requestInit,
    responseData,
    responseError,
    handler,
  };
}

/**
 * Creates a {@link StreamProcedure}, optionally with an initialization message.
 */
// signature: with default errors
function stream<
  State,
  RequestInit extends PayloadType,
  RequestData extends PayloadType,
  ResponseData extends PayloadType,
>(def: {
  requestInit: RequestInit;
  requestData: RequestData;
  responseData: ResponseData;
  responseError?: never;
  description?: string;
  handler: StreamProcedure<
    State,
    RequestInit,
    RequestData,
    ResponseData,
    TNever
  >['handler'];
}): Branded<
  StreamProcedure<State, RequestInit, RequestData, ResponseData, TNever>
>;

// signature: explicit errors
function stream<
  State,
  RequestInit extends PayloadType,
  RequestData extends PayloadType,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
>(def: {
  requestInit: RequestInit;
  requestData: RequestData;
  responseData: ResponseData;
  responseError: ResponseErr;
  description?: string;
  handler: StreamProcedure<
    State,
    RequestInit,
    RequestData,
    ResponseData,
    ResponseErr
  >['handler'];
}): Branded<
  StreamProcedure<State, RequestInit, RequestData, ResponseData, ResponseErr>
>;

// implementation
function stream({
  requestInit,
  requestData,
  responseData,
  responseError = Type.Never(),
  description,
  handler,
}: {
  requestInit: PayloadType;
  requestData: PayloadType;
  responseData: PayloadType;
  responseError?: ProcedureErrorSchemaType;
  description?: string;
  handler: StreamProcedure<
    object,
    PayloadType,
    PayloadType,
    PayloadType,
    ProcedureErrorSchemaType
  >['handler'];
}) {
  return {
    type: 'stream',
    ...(description ? { description } : {}),
    requestInit,
    requestData,
    responseData,
    responseError,
    handler,
  };
}

/**
 * Holds the {@link Procedure} creation functions. Use these to create
 * procedures for services. You aren't allowed to create procedures directly.
 */
export const Procedure = {
  rpc,
  upload,
  subscription,
  stream,
};
