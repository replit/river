import { TObject, Static, TUnion, TNever, Type } from '@sinclair/typebox';
import type { Pushable } from 'it-pushable';
import { ServiceContextWithTransportInfo } from './context';
import { Result, RiverError, RiverUncaughtSchema } from './result';

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
  // Client-stream (potentially preceded by an initialization message), single message from server (n:1).
  | 'upload'
  // Single message from client, stream from server (1:n).
  | 'subscription'
  // Bidirectional stream (potentially preceded by an initialization message) (n:n).
  | 'stream';

/**
 * Represents the payload type for {@link Procedure}s.
 */
export type PayloadType = TObject | TUnion<Array<TObject>>;

/**
 * Represents results from a {@link Procedure}. Might come from inside a stream or
 * from a single message.
 */
export type ProcedureResult<
  O extends PayloadType,
  E extends RiverError,
> = Result<Static<O>, Static<E> | Static<typeof RiverUncaughtSchema>>;

/**
 * Procedure for a single message in both directions (1:1).
 *
 * @template State - The context state object.
 * @template I - The TypeBox schema of the input object.
 * @template O - The TypeBox schema of the output object.
 * @template E - The TypeBox schema of the error object.
 */
export interface RPCProcedure<
  State,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
> {
  type: 'rpc';
  input: I;
  output: O;
  errors: E;
  handler(
    context: ServiceContextWithTransportInfo<State>,
    input: Static<I>,
  ): Promise<ProcedureResult<O, E>>;
}

/**
 * Procedure for a client-stream (potentially preceded by an initialization message),
 * single message from server (n:1).
 *
 * @template State - The context state object.
 * @template I - The TypeBox schema of the input object.
 * @template O - The TypeBox schema of the output object.
 * @template E - The TypeBox schema of the error object.
 * @template Init - The TypeBox schema of the input initialization object, if any.
 */
export type UploadProcedure<
  State,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
  Init extends PayloadType | null = null,
> = Init extends PayloadType
  ? {
      type: 'upload';
      init: Init;
      input: I;
      output: O;
      errors: E;
      handler(
        context: ServiceContextWithTransportInfo<State>,
        init: Static<Init>,
        input: AsyncIterableIterator<Static<I>>,
      ): Promise<ProcedureResult<O, E>>;
    }
  : {
      type: 'upload';
      input: I;
      output: O;
      errors: E;
      handler(
        context: ServiceContextWithTransportInfo<State>,
        input: AsyncIterableIterator<Static<I>>,
      ): Promise<ProcedureResult<O, E>>;
    };

/**
 * Procedure for a single message from client, stream from server (1:n).
 *
 * @template State - The context state object.
 * @template I - The TypeBox schema of the input object.
 * @template O - The TypeBox schema of the output object.
 * @template E - The TypeBox schema of the error object.
 */
export interface SubscriptionProcedure<
  State,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
> {
  type: 'subscription';
  input: I;
  output: O;
  errors: E;
  handler(
    context: ServiceContextWithTransportInfo<State>,
    input: Static<I>,
    output: Pushable<ProcedureResult<O, E>>,
  ): Promise<(() => void) | void>;
}

/**
 * Procedure for a bidirectional stream (potentially preceded by an initialization message),
 * (n:n).
 *
 * @template State - The context state object.
 * @template I - The TypeBox schema of the input object.
 * @template O - The TypeBox schema of the output object.
 * @template E - The TypeBox schema of the error object.
 * @template Init - The TypeBox schema of the input initialization object, if any.
 */
export type StreamProcedure<
  State,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
  Init extends PayloadType | null = null,
> = Init extends PayloadType
  ? {
      type: 'stream';
      init: Init;
      input: I;
      output: O;
      errors: E;
      handler(
        context: ServiceContextWithTransportInfo<State>,
        init: Static<Init>,
        input: AsyncIterableIterator<Static<I>>,
        output: Pushable<ProcedureResult<O, E>>,
      ): Promise<void>;
    }
  : {
      type: 'stream';
      input: I;
      output: O;
      errors: E;
      handler(
        context: ServiceContextWithTransportInfo<State>,
        input: AsyncIterableIterator<Static<I>>,
        output: Pushable<ProcedureResult<O, E>>,
      ): Promise<void>;
    };

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
 * @template I - The TypeBox schema of the input object.
 * @template O - The TypeBox schema of the output object.
 * @template Init - The TypeBox schema of the input initialization object, if any.
 */
// prettier-ignore
export type Procedure<
  State,
  Ty extends ValidProcType,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
  Init extends PayloadType | null = null,
> = { type: Ty } & (
  Init extends PayloadType
    ? Ty extends 'upload' ? UploadProcedure<State, I, O, E, Init>
    : Ty extends 'stream' ? StreamProcedure<State, I, O, E, Init>
    : never
  : Ty extends 'rpc' ? RPCProcedure<State, I, O, E>
  : Ty extends 'upload' ? UploadProcedure<State, I, O, E>
  : Ty extends 'subscription' ? SubscriptionProcedure<State, I, O, E>
  : Ty extends 'stream' ? StreamProcedure<State, I, O, E>
  : never
);
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
  PayloadType,
  RiverError,
  PayloadType | null
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
 * Creates an {@link RPCProcedure}.
 */
// signature: default errors
function rpc<State, I extends PayloadType, O extends PayloadType>(def: {
  input: I;
  output: O;
  errors?: never;
  handler: RPCProcedure<State, I, O, TNever>['handler'];
}): Branded<RPCProcedure<State, I, O, TNever>>;

// signature: explicit errors
function rpc<
  State,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
>(def: {
  input: I;
  output: O;
  errors: E;
  handler: RPCProcedure<State, I, O, E>['handler'];
}): Branded<RPCProcedure<State, I, O, E>>;

// implementation
function rpc({
  input,
  output,
  errors = Type.Never(),
  handler,
}: {
  input: PayloadType;
  output: PayloadType;
  errors?: RiverError;
  handler: RPCProcedure<
    object,
    PayloadType,
    PayloadType,
    RiverError
  >['handler'];
}) {
  return { type: 'rpc', input, output, errors, handler };
}

/**
 * Creates an {@link UploadProcedure}, optionally with an initialization message.
 */
// signature: init with default errors
function upload<
  State,
  I extends PayloadType,
  O extends PayloadType,
  Init extends PayloadType,
>(def: {
  init: Init;
  input: I;
  output: O;
  errors?: never;
  handler: UploadProcedure<State, I, O, TNever, Init>['handler'];
}): Branded<UploadProcedure<State, I, O, TNever, Init>>;

// signature: init with explicit errors
function upload<
  State,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
  Init extends PayloadType,
>(def: {
  init: Init;
  input: I;
  output: O;
  errors: E;
  handler: UploadProcedure<State, I, O, E, Init>['handler'];
}): Branded<UploadProcedure<State, I, O, E, Init>>;

// signature: no init with default errors
function upload<State, I extends PayloadType, O extends PayloadType>(def: {
  input: I;
  output: O;
  errors?: never;
  handler: UploadProcedure<State, I, O, TNever>['handler'];
}): Branded<UploadProcedure<State, I, O, TNever>>;

// signature: no init with explicit errors
function upload<
  State,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
>(def: {
  input: I;
  output: O;
  errors: E;
  handler: UploadProcedure<State, I, O, E>['handler'];
}): Branded<UploadProcedure<State, I, O, E>>;

// implementation
function upload({
  init,
  input,
  output,
  errors = Type.Never(),
  handler,
}: {
  init?: PayloadType | null;
  input: PayloadType;
  output: PayloadType;
  errors?: RiverError;
  handler: UploadProcedure<
    object,
    PayloadType,
    PayloadType,
    RiverError,
    PayloadType | null
  >['handler'];
}) {
  return init !== undefined && init !== null
    ? { type: 'upload', init, input, output, errors, handler }
    : { type: 'upload', input, output, errors, handler };
}

/**
 * Creates a {@link SubscriptionProcedure}.
 */
// signature: default errors
function subscription<
  State,
  I extends PayloadType,
  O extends PayloadType,
>(def: {
  input: I;
  output: O;
  errors?: never;
  handler: SubscriptionProcedure<State, I, O, TNever>['handler'];
}): Branded<SubscriptionProcedure<State, I, O, TNever>>;

// signature: explicit errors
function subscription<
  State,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
>(def: {
  input: I;
  output: O;
  errors: E;
  handler: SubscriptionProcedure<State, I, O, E>['handler'];
}): Branded<SubscriptionProcedure<State, I, O, E>>;

// implementation
function subscription({
  input,
  output,
  errors = Type.Never(),
  handler,
}: {
  input: PayloadType;
  output: PayloadType;
  errors?: RiverError;
  handler: SubscriptionProcedure<
    object,
    PayloadType,
    PayloadType,
    RiverError
  >['handler'];
}) {
  return { type: 'subscription', input, output, errors, handler };
}

/**
 * Creates a {@link StreamProcedure}, optionally with an initialization message.
 */
// signature: init with default errors
function stream<
  State,
  I extends PayloadType,
  O extends PayloadType,
  Init extends PayloadType,
>(def: {
  init: Init;
  input: I;
  output: O;
  errors?: never;
  handler: StreamProcedure<State, I, O, TNever, Init>['handler'];
}): Branded<StreamProcedure<State, I, O, TNever, Init>>;

// signature: init with explicit errors
function stream<
  State,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
  Init extends PayloadType,
>(def: {
  init: Init;
  input: I;
  output: O;
  errors: E;
  handler: StreamProcedure<State, I, O, E, Init>['handler'];
}): Branded<StreamProcedure<State, I, O, E, Init>>;

// signature: no init with default errors
function stream<State, I extends PayloadType, O extends PayloadType>(def: {
  input: I;
  output: O;
  errors?: never;
  handler: StreamProcedure<State, I, O, TNever>['handler'];
}): Branded<StreamProcedure<State, I, O, TNever>>;

// signature: no init with explicit errors
function stream<
  State,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
>(def: {
  input: I;
  output: O;
  errors: E;
  handler: StreamProcedure<State, I, O, E>['handler'];
}): Branded<StreamProcedure<State, I, O, E>>;

// implementation
function stream({
  init,
  input,
  output,
  errors = Type.Never(),
  handler,
}: {
  init?: PayloadType | null;
  input: PayloadType;
  output: PayloadType;
  errors?: RiverError;
  handler: StreamProcedure<
    object,
    PayloadType,
    PayloadType,
    RiverError,
    PayloadType | null
  >['handler'];
}) {
  return init !== undefined && init !== null
    ? { type: 'stream', init, input, output, errors, handler }
    : { type: 'stream', input, output, errors, handler };
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
