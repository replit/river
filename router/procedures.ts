import { TObject, Static, TUnion } from '@sinclair/typebox';
import type { Pushable } from 'it-pushable';
import { ServiceContextWithTransportInfo } from './context';
import { Result, RiverError } from './result';

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
  handler: (
    context: ServiceContextWithTransportInfo<State>,
    input: Static<I>,
  ) => Promise<Result<Static<O>, Static<E>>>;
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
      handler: (
        context: ServiceContextWithTransportInfo<State>,
        init: Static<Init>,
        input: AsyncIterableIterator<Static<I>>,
      ) => Promise<Result<Static<O>, Static<E>>>;
    }
  : {
      type: 'upload';
      input: I;
      output: O;
      errors: E;
      handler: (
        context: ServiceContextWithTransportInfo<State>,
        input: AsyncIterableIterator<Static<I>>,
      ) => Promise<Result<Static<O>, Static<E>>>;
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
  handler: (
    context: ServiceContextWithTransportInfo<State>,
    input: Static<I>,
    output: Pushable<Result<Static<O>, Static<E>>>,
  ) => Promise<(() => void) | void>;
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
      handler: (
        context: ServiceContextWithTransportInfo<State>,
        init: Static<Init>,
        input: AsyncIterableIterator<Static<I>>,
        output: Pushable<Result<Static<O>, Static<E>>>,
      ) => Promise<void>;
    }
  : {
      type: 'stream';
      input: I;
      output: O;
      errors: E;
      handler: (
        context: ServiceContextWithTransportInfo<State>,
        input: AsyncIterableIterator<Static<I>>,
        output: Pushable<Result<Static<O>, Static<E>>>,
      ) => Promise<void>;
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
export type ProcListing<State = object> = Record<string, AnyProcedure<State>>;
