import { Static, TNever, TSchema, TUnion, Type } from '@sinclair/typebox';
import { Readable } from '../readable';
import {
  BaseErrorSchemaType,
  RequestBuiltInErrorSchema,
} from '../result/errors';
import { Result } from '../result/result';
import { Writable } from '../writable';
import { ProcedureHandlerContext } from './context';

/**
 * Brands a type to prevent it from being directly constructed.
 */
export type Branded<T> = T & { readonly __BRAND_DO_NOT_USE: unique symbol };

/**
 * Unbrands a {@link Branded} type.
 */
export type Unbranded<T> = T extends Branded<infer U> ? U : never;

// Allow specific levels of nesting, otherwise typescript shits itself due to recursion
type ProcedureErrorUnionSchema0 = TUnion<Array<BaseErrorSchemaType>>;
type ProcedureErrorUnionSchema1 = TUnion<
  Array<ProcedureErrorUnionSchema0 | BaseErrorSchemaType>
>;
type ProcedureErrorUnionSchema2 = TUnion<
  Array<
    | ProcedureErrorUnionSchema1
    | ProcedureErrorUnionSchema0
    | BaseErrorSchemaType
  >
>;

/**
 * Represents an acceptable schema to pass to a procedure.
 * Just a type of a schema, not an actual schema.
 */
export type ProcedureErrorSchemaType =
  | ProcedureErrorUnionSchema2
  | BaseErrorSchemaType
  | TNever;

/**
 * The valid {@link Procedure} types.
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
 * Procedure for a single message in both directions (1:1).
 *
 * @template State - The context state object.
 * @template RequestInit - The TypeBox schema of the initialization object.
 * @template ResponseData - The TypeBox schema of the output object.
 * @template ResponseErr - The TypeBox schema of the error object.
 */
export interface RPCProcedure<
  State,
  RequestInit extends TSchema,
  ResponseData extends TSchema,
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
 * Creates an {@link RPCProcedure}.
 */
// signature: default errors
function rpc<
  State,
  RequestInit extends TSchema,
  ResponseData extends TSchema,
>(def: {
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError?: never;
  description?: string;
  handler: RPCProcedure<State, RequestInit, ResponseData, TNever>['handler'];
}): Branded<RPCProcedure<State, RequestInit, ResponseData, TNever>>;

// signature: explicit errors
function rpc<
  State,
  RequestInit extends TSchema,
  ResponseData extends TSchema,
  ResponseErr extends ProcedureErrorSchemaType,
>(def: {
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError: ResponseErr;
  description?: string;
  handler: RPCProcedure<
    State,
    RequestInit,
    ResponseData,
    ResponseErr
  >['handler'];
}): Branded<RPCProcedure<State, RequestInit, ResponseData, ResponseErr>>;

// implementation
function rpc({
  requestInit,
  responseData,
  responseError = Type.Never(),
  description,
  handler,
}: {
  requestInit: TSchema;
  responseData: TSchema;
  responseError?: ProcedureErrorSchemaType;
  description?: string;
  handler: RPCProcedure<
    object,
    TSchema,
    TSchema,
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
 * Procedure for a client-stream (potentially preceded by an initialization message),
 * single message from server (n:1).
 *
 * @template State - The context state object.
 * @template RequestInit - The TypeBox schema of the initialization object.
 * @template RequestData - The TypeBox schema of the input object.
 * @template ResponseData - The TypeBox schema of the output object.
 * @template ResponseErr - The TypeBox schema of the error object.
 */
export interface UploadProcedure<
  State,
  RequestInit extends TSchema,
  RequestData extends TSchema,
  ResponseData extends TSchema,
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
      Static<typeof RequestBuiltInErrorSchema>
    >;
  }): Promise<Result<Static<ResponseData>, Static<ResponseErr>>>;
}

/**
 * Creates an {@link UploadProcedure}, optionally with an initialization message.
 */
// signature: init with default errors
function upload<
  State,
  RequestInit extends TSchema,
  RequestData extends TSchema,
  ResponseData extends TSchema,
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
  RequestInit extends TSchema,
  RequestData extends TSchema,
  ResponseData extends TSchema,
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
  requestInit: TSchema;
  requestData: TSchema;
  responseData: TSchema;
  responseError?: ProcedureErrorSchemaType;
  description?: string;
  handler: UploadProcedure<
    object,
    TSchema,
    TSchema,
    TSchema,
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
 * Procedure for a single message from client, stream from server (1:n).
 *
 * @template State - The context state object.
 * @template RequestInit - The TypeBox schema of the initialization object.
 * @template ResponseData - The TypeBox schema of the output object.
 * @template ResponseErr - The TypeBox schema of the error object.
 */
export interface SubscriptionProcedure<
  State,
  RequestInit extends TSchema,
  ResponseData extends TSchema,
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
 * Creates a {@link SubscriptionProcedure}.
 */
// signature: default errors
function subscription<
  State,
  RequestInit extends TSchema,
  ResponseData extends TSchema,
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
  RequestInit extends TSchema,
  ResponseData extends TSchema,
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
  requestInit: TSchema;
  responseData: TSchema;
  responseError?: ProcedureErrorSchemaType;
  description?: string;
  handler: SubscriptionProcedure<
    object,
    TSchema,
    TSchema,
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
 * Procedure for a bidirectional stream (potentially preceded by an initialization message),
 * (n:n).
 *
 * @template State - The context state object.
 * @template RequestInit - The TypeBox schema of the initialization object.
 * @template RequestData - The TypeBox schema of the input object.
 * @template ResponseData - The TypeBox schema of the output object.
 * @template ResponseErr - The TypeBox schema of the error object.
 */
export interface StreamProcedure<
  State,
  RequestInit extends TSchema,
  RequestData extends TSchema,
  ResponseData extends TSchema,
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
      Static<typeof RequestBuiltInErrorSchema>
    >;
    resWritable: Writable<Result<Static<ResponseData>, Static<ResponseErr>>>;
  }): Promise<void | undefined>;
}

/**
 * Creates a {@link StreamProcedure}, optionally with an initialization message.
 */
// signature: with default errors
function stream<
  State,
  RequestInit extends TSchema,
  RequestData extends TSchema,
  ResponseData extends TSchema,
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
  RequestInit extends TSchema,
  RequestData extends TSchema,
  ResponseData extends TSchema,
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
  requestInit: TSchema;
  requestData: TSchema;
  responseData: TSchema;
  responseError?: ProcedureErrorSchemaType;
  description?: string;
  handler: StreamProcedure<
    object,
    TSchema,
    TSchema,
    TSchema,
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
 * Defines a Procedure type that can be a:
 * - {@link RPCProcedure} for a single message in both directions (1:1)
 * - {@link UploadProcedure} for a client-stream (potentially preceded by an
 *   initialization message)
 * - {@link SubscriptionProcedure} for a single message from client, stream from server (1:n)
 * - {@link StreamProcedure} for a bidirectional stream (potentially preceded by an
 *    initialization message)
 *
 * @template State - The TypeBox schema of the state object.
 * @template Ty - The type of the procedure.
 * @template RequestData - The TypeBox schema of the input object.
 * @template RequestInit - The TypeBox schema of the input initialization object, if any.
 * @template ResponseData - The TypeBox schema of the output object.
 */
export type Procedure<
  State,
  Ty extends ValidProcType,
  RequestInit extends TSchema,
  RequestData extends TSchema | null,
  ResponseData extends TSchema,
  ResponseErr extends ProcedureErrorSchemaType,
> = { type: Ty } & (RequestData extends TSchema
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
  ? RPCProcedure<State, RequestInit, ResponseData, ResponseErr>
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
  TSchema,
  TSchema | null,
  TSchema,
  ProcedureErrorSchemaType
>;

/**
 * Represents a map of {@link Procedure}s.
 *
 * @template State - The context state object. You can provide this to constrain
 *                   the type of procedures.
 */
export type ProcedureMap<State = object> = Record<string, AnyProcedure<State>>;

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
