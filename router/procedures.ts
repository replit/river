/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { Static, TNever, TSchema, Type } from '@sinclair/typebox';
import { ProcedureHandlerContext } from './context';
import { Result } from './result';
import { Readable, Writable } from './streams';
import {
  CancelErrorSchema,
  ProcedureErrorSchemaType,
  ReaderErrorSchema,
} from './errors';

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

export type Cancellable<T> = T | Static<typeof CancelErrorSchema>;

/**
 * Procedure for a single message in both directions (1:1).
 *
 * @template State - The context state object.
 * @template RequestInit - The TypeBox schema of the initialization object.
 * @template ResponseData - The TypeBox schema of the response object.
 * @template ResponseErr - The TypeBox schema of the error object.
 */
export interface RpcProcedure<
  Context,
  State,
  ParsedMetadata,
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
    ctx: ProcedureHandlerContext<State, Context, ParsedMetadata>;
    reqInit: Static<RequestInit>;
  }): Promise<Result<Static<ResponseData>, Cancellable<Static<ResponseErr>>>>;
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
  Context,
  State,
  ParsedMetadata,
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
    ctx: ProcedureHandlerContext<State, Context, ParsedMetadata>;
    reqInit: Static<RequestInit>;
    reqReadable: Readable<
      Static<RequestData>,
      Static<typeof ReaderErrorSchema>
    >;
  }): Promise<Result<Static<ResponseData>, Cancellable<Static<ResponseErr>>>>;
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
  Context,
  State,
  ParsedMetadata,
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
    ctx: ProcedureHandlerContext<State, Context, ParsedMetadata>;
    reqInit: Static<RequestInit>;
    resWritable: Writable<
      Result<Static<ResponseData>, Cancellable<Static<ResponseErr>>>
    >;
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
  Context,
  State,
  ParsedMetadata,
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
    ctx: ProcedureHandlerContext<State, Context, ParsedMetadata>;
    reqInit: Static<RequestInit>;
    reqReadable: Readable<
      Static<RequestData>,
      Static<typeof ReaderErrorSchema>
    >;
    resWritable: Writable<
      Result<Static<ResponseData>, Cancellable<Static<ResponseErr>>>
    >;
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
  Context,
  State,
  ParsedMetadata,
  Ty extends ValidProcType,
  RequestInit extends PayloadType,
  RequestData extends PayloadType | null,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
> = { type: Ty } & (RequestData extends PayloadType
  ? Ty extends 'upload'
    ? UploadProcedure<
        Context,
        State,
        ParsedMetadata,
        RequestInit,
        RequestData,
        ResponseData,
        ResponseErr
      >
    : Ty extends 'stream'
    ? StreamProcedure<
        Context,
        State,
        ParsedMetadata,
        RequestInit,
        RequestData,
        ResponseData,
        ResponseErr
      >
    : never
  : Ty extends 'rpc'
  ? RpcProcedure<
      Context,
      State,
      ParsedMetadata,
      RequestInit,
      ResponseData,
      ResponseErr
    >
  : Ty extends 'subscription'
  ? SubscriptionProcedure<
      Context,
      State,
      ParsedMetadata,
      RequestInit,
      ResponseData,
      ResponseErr
    >
  : never);

/**
 * Represents any {@link Procedure} type.
 *
 * @template State - The context state object. You can provide this to constrain
 *                   the type of procedures.
 */
export type AnyProcedure<
  Context = object,
  State = object,
  ParsedMetadata = object,
> = Procedure<
  Context,
  State,
  ParsedMetadata,
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
export type ProcedureMap<
  Context = object,
  State = object,
  ParsedMetadata = object,
> = Record<string, AnyProcedure<Context, State, ParsedMetadata>>;

// typescript is funky so with these upcoming procedure constructors, the overloads
// which handle the `init` case _must_ come first, otherwise the `init` property
// is not recognized as optional, for some reason

/**
 * Creates an {@link RpcProcedure}.
 */
// signature: default errors
function rpc<
  Context,
  State,
  ParsedMetadata,
  RequestInit extends PayloadType,
  ResponseData extends PayloadType,
>(def: {
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError?: never;
  description?: string;
  handler: RpcProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    ResponseData,
    TNever
  >['handler'];
}): Branded<
  RpcProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    ResponseData,
    TNever
  >
>;

// signature: explicit errors
function rpc<
  Context,
  State,
  ParsedMetadata,
  RequestInit extends PayloadType,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
>(def: {
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError: ResponseErr;
  description?: string;
  handler: RpcProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    ResponseData,
    ResponseErr
  >['handler'];
}): Branded<
  RpcProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    ResponseData,
    ResponseErr
  >
>;

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
    object,
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
  Context,
  State,
  ParsedMetadata,
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
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    RequestData,
    ResponseData,
    TNever
  >['handler'];
}): Branded<
  UploadProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    RequestData,
    ResponseData,
    TNever
  >
>;

// signature: init with explicit errors
function upload<
  Context,
  State,
  ParsedMetadata,
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
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    RequestData,
    ResponseData,
    ResponseErr
  >['handler'];
}): Branded<
  UploadProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    RequestData,
    ResponseData,
    ResponseErr
  >
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
    object,
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
  Context,
  State,
  ParsedMetadata,
  RequestInit extends PayloadType,
  ResponseData extends PayloadType,
>(def: {
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError?: never;
  description?: string;
  handler: SubscriptionProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    ResponseData,
    TNever
  >['handler'];
}): Branded<
  SubscriptionProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    ResponseData,
    TNever
  >
>;

// signature: explicit errors
function subscription<
  Context,
  State,
  ParsedMetadata,
  RequestInit extends PayloadType,
  ResponseData extends PayloadType,
  ResponseErr extends ProcedureErrorSchemaType,
>(def: {
  requestInit: RequestInit;
  responseData: ResponseData;
  responseError: ResponseErr;
  description?: string;
  handler: SubscriptionProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    ResponseData,
    ResponseErr
  >['handler'];
}): Branded<
  SubscriptionProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    ResponseData,
    ResponseErr
  >
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
    object,
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
  Context,
  State,
  ParsedMetadata,
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
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    RequestData,
    ResponseData,
    TNever
  >['handler'];
}): Branded<
  StreamProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    RequestData,
    ResponseData,
    TNever
  >
>;

// signature: explicit errors
function stream<
  Context,
  State,
  ParsedMetadata,
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
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    RequestData,
    ResponseData,
    ResponseErr
  >['handler'];
}): Branded<
  StreamProcedure<
    Context,
    State,
    ParsedMetadata,
    RequestInit,
    RequestData,
    ResponseData,
    ResponseErr
  >
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
    object,
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
