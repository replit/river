/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import { Static, TNever, TSchema, TUnion, Type } from '@sinclair/typebox';
import { ProcedureHandlerContext } from './context';
import { BaseErrorSchemaType, Result } from './result';
import { ReadStream, WriteStream } from './streams';

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
 * INTERNAL_RIVER_ERROR_CODE is the code that is used when an internal error occurs,
 * this means that some invariants expected by the river server implementation have
 * been violated. When encountering this error please report this to river maintainers.
 */
export const INTERNAL_RIVER_ERROR_CODE = 'INTERNAL_RIVER_ERROR';
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
 * OutputReaderErrorSchema is the schema for all the errors that can be
 * emitted in the Output ReadStream on the client.
 */
export const OutputReaderErrorSchema = Type.Object({
  code: Type.Union([
    Type.Literal(INTERNAL_RIVER_ERROR_CODE),
    Type.Literal(UNCAUGHT_ERROR_CODE),
    Type.Literal(UNEXPECTED_DISCONNECT_CODE),
    Type.Literal(INVALID_REQUEST_CODE),
    Type.Literal(ABORT_CODE),
  ]),
  message: Type.String(),
});

/**
 * InputReaderErrorSchema is the schema for all the errors that can be
 * emitted in the Input ReadStream on the server.
 */
export const InputReaderErrorSchema = Type.Object({
  code: Type.Union([
    Type.Literal(UNCAUGHT_ERROR_CODE),
    Type.Literal(UNEXPECTED_DISCONNECT_CODE),
    Type.Literal(INVALID_REQUEST_CODE),
    Type.Literal(ABORT_CODE),
  ]),
  message: Type.String(),
});

/**
 * Represents an acceptable schema to pass to a procedure.
 * Just a type of a schema, not an actual schema.
 */
export type ProcedureErrorSchemaType =
  | TUnion<Array<BaseErrorSchemaType>>
  | BaseErrorSchemaType
  | TNever;

/**
 * Procedure for a single message in both directions (1:1).
 *
 * @template State - The context state object.
 * @template Init - The TypeBox schema of the initialization object.
 * @template Output - The TypeBox schema of the output object.
 * @template Err - The TypeBox schema of the error object.
 */
export interface RpcProcedure<
  State,
  Init extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
> {
  type: 'rpc';
  init: Init;
  output: Output;
  errors: Err;
  description?: string;
  handler(
    context: ProcedureHandlerContext<State>,
    init: Static<Init>,
  ): Promise<Result<Static<Output>, Static<Err>>>;
}

/**
 * Procedure for a client-stream (potentially preceded by an initialization message),
 * single message from server (n:1).
 *
 * @template State - The context state object.
 * @template Init - The TypeBox schema of the initialization object.
 * @template Input - The TypeBox schema of the input object.
 * @template Output - The TypeBox schema of the output object.
 * @template Err - The TypeBox schema of the error object.
 */
export interface UploadProcedure<
  State,
  Init extends PayloadType,
  Input extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
> {
  type: 'upload';
  init: Init;
  input: Input;
  output: Output;
  errors: Err;
  description?: string;
  handler(
    context: ProcedureHandlerContext<State>,
    init: Static<Init>,
    input: ReadStream<Static<Input>, Static<typeof InputReaderErrorSchema>>,
  ): Promise<Result<Static<Output>, Static<Err>>>;
}

/**
 * Procedure for a single message from client, stream from server (1:n).
 *
 * @template State - The context state object.
 * @template Init - The TypeBox schema of the initialization object.
 * @template Output - The TypeBox schema of the output object.
 * @template Err - The TypeBox schema of the error object.
 */
export interface SubscriptionProcedure<
  State,
  Init extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
> {
  type: 'subscription';
  init: Init;
  output: Output;
  errors: Err;
  description?: string;
  handler(
    context: ProcedureHandlerContext<State>,
    init: Static<Init>,
    output: WriteStream<Result<Static<Output>, Static<Err>>>,
  ): Promise<void | undefined>;
}

/**
 * Procedure for a bidirectional stream (potentially preceded by an initialization message),
 * (n:n).
 *
 * @template State - The context state object.
 * @template Init - The TypeBox schema of the initialization object.
 * @template Input - The TypeBox schema of the input object.
 * @template Output - The TypeBox schema of the output object.
 * @template Err - The TypeBox schema of the error object.
 */
export interface StreamProcedure<
  State,
  Init extends PayloadType,
  Input extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
> {
  type: 'stream';
  init: Init;
  input: Input;
  output: Output;
  errors: Err;
  description?: string;
  handler(
    context: ProcedureHandlerContext<State>,
    init: Static<Init>,
    input: ReadStream<Static<Input>, Static<typeof InputReaderErrorSchema>>,
    output: WriteStream<Result<Static<Output>, Static<Err>>>,
  ): Promise<void | undefined>;
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
 * @template Input - The TypeBox schema of the input object.
 * @template Init - The TypeBox schema of the input initialization object, if any.
 * @template Output - The TypeBox schema of the output object.
 */
export type Procedure<
  State,
  Ty extends ValidProcType,
  Init extends PayloadType,
  Input extends PayloadType | null,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
> = { type: Ty } & (Input extends PayloadType
  ? Ty extends 'upload'
    ? UploadProcedure<State, Init, Input, Output, Err>
    : Ty extends 'stream'
    ? StreamProcedure<State, Init, Input, Output, Err>
    : never
  : Ty extends 'rpc'
  ? RpcProcedure<State, Init, Output, Err>
  : Ty extends 'subscription'
  ? SubscriptionProcedure<State, Init, Output, Err>
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
function rpc<State, Init extends PayloadType, Output extends PayloadType>(def: {
  init: Init;
  output: Output;
  errors?: never;
  description?: string;
  handler: RpcProcedure<State, Init, Output, TNever>['handler'];
}): Branded<RpcProcedure<State, Init, Output, TNever>>;

// signature: explicit errors
function rpc<
  State,
  Init extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(def: {
  init: Init;
  output: Output;
  errors: Err;
  description?: string;
  handler: RpcProcedure<State, Init, Output, Err>['handler'];
}): Branded<RpcProcedure<State, Init, Output, Err>>;

// implementation
function rpc({
  init,
  output,
  errors = Type.Never(),
  description,
  handler,
}: {
  init: PayloadType;
  output: PayloadType;
  errors?: ProcedureErrorSchemaType;
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
    init,
    output,
    errors,
    handler,
  };
}

/**
 * Creates an {@link UploadProcedure}, optionally with an initialization message.
 */
// signature: init with default errors
function upload<
  State,
  Init extends PayloadType,
  Input extends PayloadType,
  Output extends PayloadType,
>(def: {
  init: Init;
  input: Input;
  output: Output;
  errors?: never;
  description?: string;
  handler: UploadProcedure<State, Init, Input, Output, TNever>['handler'];
}): Branded<UploadProcedure<State, Init, Input, Output, TNever>>;

// signature: init with explicit errors
function upload<
  State,
  Init extends PayloadType,
  Input extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(def: {
  init: Init;
  input: Input;
  output: Output;
  errors: Err;
  description?: string;
  handler: UploadProcedure<State, Init, Input, Output, Err>['handler'];
}): Branded<UploadProcedure<State, Init, Input, Output, Err>>;

// implementation
function upload({
  init,
  input,
  output,
  errors = Type.Never(),
  description,
  handler,
}: {
  init: PayloadType;
  input: PayloadType;
  output: PayloadType;
  errors?: ProcedureErrorSchemaType;
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
    init,
    input,
    output,
    errors,
    handler,
  };
}

/**
 * Creates a {@link SubscriptionProcedure}.
 */
// signature: default errors
function subscription<
  State,
  Init extends PayloadType,
  Output extends PayloadType,
>(def: {
  init: Init;
  output: Output;
  errors?: never;
  description?: string;
  handler: SubscriptionProcedure<State, Init, Output, TNever>['handler'];
}): Branded<SubscriptionProcedure<State, Init, Output, TNever>>;

// signature: explicit errors
function subscription<
  State,
  Init extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(def: {
  init: Init;
  output: Output;
  errors: Err;
  description?: string;
  handler: SubscriptionProcedure<State, Init, Output, Err>['handler'];
}): Branded<SubscriptionProcedure<State, Init, Output, Err>>;

// implementation
function subscription({
  init,
  output,
  errors = Type.Never(),
  description,
  handler,
}: {
  init: PayloadType;
  output: PayloadType;
  errors?: ProcedureErrorSchemaType;
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
    init,
    output,
    errors,
    handler,
  };
}

/**
 * Creates a {@link StreamProcedure}, optionally with an initialization message.
 */
// signature: with default errors
function stream<
  State,
  Init extends PayloadType,
  Input extends PayloadType,
  Output extends PayloadType,
>(def: {
  init: Init;
  input: Input;
  output: Output;
  errors?: never;
  description?: string;
  handler: StreamProcedure<State, Init, Input, Output, TNever>['handler'];
}): Branded<StreamProcedure<State, Init, Input, Output, TNever>>;

// signature: explicit errors
function stream<
  State,
  Init extends PayloadType,
  Input extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(def: {
  init: Init;
  input: Input;
  output: Output;
  errors: Err;
  description?: string;
  handler: StreamProcedure<State, Init, Input, Output, Err>['handler'];
}): Branded<StreamProcedure<State, Init, Input, Output, Err>>;

// implementation
function stream({
  init,
  input,
  output,
  errors = Type.Never(),
  description,
  handler,
}: {
  init: PayloadType;
  input: PayloadType;
  output: PayloadType;
  errors?: ProcedureErrorSchemaType;
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
    init,
    input,
    output,
    errors,
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
