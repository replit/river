import { TObject, Static, Type, TUnion } from '@sinclair/typebox';
import type { Pushable } from 'it-pushable';
import { ServiceContextWithTransportInfo } from './context';
import { Result, RiverError, RiverUncaughtSchema } from './result';

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
 * A generic procedure listing where the keys are the names of the procedures
 * and the values are the {@link Procedure} definitions. This is not meant to
 * be constructed directly, use the {@link ServiceBuilder} class instead.
 */
export type ProcListing = Record<string, AnyProcedure>;

/**
 * Represents a service with a name, state, and procedures.
 * This is not meant to be constructed directly, use the {@link ServiceBuilder} class instead.
 * @template Name The type of the service name.
 * @template State The type of the service state.
 * @template Procs The type of the service procedures.
 */
export interface Service<
  Name extends string,
  State extends object,
  // nested record (service listing contains services which have proc listings)
  // this means we lose type specificity on our procedures here so we maintain it by using
  // any on the default type
  Procs extends ProcListing,
> {
  name: Name;
  state: State;
  procedures: Procs;
}
export type AnyService = Service<string, object, ProcListing>;

/**
 * Serializes a service object into its corresponding JSON Schema Draft 7 type.
 * @param {AnyService} s - The service object to serialize.
 * @returns A plain object representing the serialized service.
 */
export function serializeService(s: AnyService): object {
  return {
    name: s.name,
    state: s.state,
    procedures: Object.fromEntries(
      Object.entries<AnyProcedure>(s.procedures).map(([procName, procDef]) => [
        procName,
        {
          input: Type.Strict(procDef.input),
          output: Type.Strict(procDef.output),
          // Only add the `errors` field if it is non-never.
          ...('errors' in procDef
            ? {
                errors: Type.Strict(procDef.errors),
              }
            : {}),
          type: procDef.type,
          // Only add the `init` field if the type declares it.
          ...('init' in procDef
            ? {
                init: Type.Strict(procDef.init),
              }
            : {}),
        },
      ]),
    ),
  };
}

/**
 * Helper to get the type definition for a specific handler of a procedure in a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcHandler<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['handler'];

/**
 * Helper to get whether the type definition for the procedure contains an init type.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcHasInit<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName] extends { init: TObject } ? true : false;

/**
 * Helper to get the type definition for the procedure init type of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcInit<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName] extends { init: TObject }
  ? S['procedures'][ProcName]['init']
  : never;

/**
 * Helper to get the type definition for the procedure input of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcInput<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['input'];

/**
 * Helper to get the type definition for the procedure output of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcOutput<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['output'];

/**
 * Helper to get the type definition for the procedure errors of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcErrors<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = TUnion<[S['procedures'][ProcName]['errors'], typeof RiverUncaughtSchema]>;

/**
 * Helper to get the type of procedure in a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcType<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['type'];

export type PayloadType = TObject | TUnion<Array<TObject>>;

/**
 * Defines a Procedure type that can be either an RPC or a stream procedure.
 * @template State - The TypeBox schema of the state object.
 * @template Ty - The type of the procedure.
 * @template I - The TypeBox schema of the input object.
 * @template O - The TypeBox schema of the output object.
 * @template Init - The TypeBox schema of the input initialization object.
 */
export type Procedure<
  State,
  Ty extends ValidProcType,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
  Init extends PayloadType | null = null,
> = Ty extends 'rpc'
  ? Init extends null
    ? {
        input: I;
        output: O;
        errors: E;
        handler: (
          context: ServiceContextWithTransportInfo<State>,
          input: Static<I>,
        ) => Promise<Result<Static<O>, Static<E>>>;
        type: Ty;
      }
    : never
  : Ty extends 'upload'
  ? Init extends PayloadType
    ? {
        init: Init;
        input: I;
        output: O;
        errors: E;
        handler: (
          context: ServiceContextWithTransportInfo<State>,
          init: Static<Init>,
          input: AsyncIterableIterator<Static<I>>,
        ) => Promise<Result<Static<O>, Static<E>>>;
        type: Ty;
      }
    : {
        input: I;
        output: O;
        errors: E;
        handler: (
          context: ServiceContextWithTransportInfo<State>,
          input: AsyncIterableIterator<Static<I>>,
        ) => Promise<Result<Static<O>, Static<E>>>;
        type: Ty;
      }
  : Ty extends 'subscription'
  ? Init extends null
    ? {
        input: I;
        output: O;
        errors: E;
        handler: (
          context: ServiceContextWithTransportInfo<State>,
          input: Static<I>,
          output: Pushable<Result<Static<O>, Static<E>>>,
        ) => Promise<(() => void) | void>;
        type: Ty;
      }
    : never
  : Ty extends 'stream'
  ? Init extends PayloadType
    ? {
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
        type: Ty;
      }
    : {
        input: I;
        output: O;
        errors: E;
        handler: (
          context: ServiceContextWithTransportInfo<State>,
          input: AsyncIterableIterator<Static<I>>,
          output: Pushable<Result<Static<O>, Static<E>>>,
        ) => Promise<void>;
        type: Ty;
      }
  : never;
export type AnyProcedure = Procedure<
  object,
  ValidProcType,
  PayloadType,
  PayloadType,
  RiverError,
  PayloadType | null
>;

/**
 * A builder class for creating River Services.
 * You must call the finalize method to get the finalized schema for use in a service router.
 * @template T The type of the service.
 */
export class ServiceBuilder<T extends Service<string, object, ProcListing>> {
  private readonly schema: T;
  private constructor(schema: T) {
    this.schema = schema;
  }

  /**
   * Finalizes the schema for the service.
   */
  finalize() {
    return Object.freeze(this.schema);
  }

  /**
   * Sets the initial state for the service.
   * @template InitState The type of the initial state.
   * @param {InitState} state The initial state for the service.
   * @returns {ServiceBuilder<{ name: T['name']; state: InitState; procedures: T['procedures']; }>} A new ServiceBuilder instance with the updated schema.
   */
  initialState<InitState extends T['state']>(
    state: InitState,
  ): ServiceBuilder<{
    name: T['name'];
    state: InitState;
    procedures: T['procedures'];
  }> {
    return new ServiceBuilder({
      ...this.schema,
      state,
    });
  }

  /**
   * Defines a new procedure for the service.
   * @param {ProcName} procName The name of the procedure.
   * @param {Procedure<T['state'], Ty, I, O, E, Init>} procDef The definition of the procedure.
   * @returns {ServiceBuilder<{ name: T['name']; state: T['state']; procedures: T['procedures'] & { [k in ProcName]: Procedure<T['state'], Ty, I, O, E, Init>; }; }>} A new ServiceBuilder instance with the updated schema.
   */
  defineProcedure<
    ProcName extends string,
    Ty extends ValidProcType,
    I extends PayloadType,
    O extends PayloadType,
    E extends RiverError,
    Init extends PayloadType | null = null,
  >(
    procName: ProcName,
    procDef: Procedure<T['state'], Ty, I, O, E, Init>,
  ): ServiceBuilder<{
    name: T['name'];
    state: T['state'];
    procedures: T['procedures'] & {
      [k in ProcName]: Procedure<T['state'], Ty, I, O, E, Init>;
    };
  }> {
    type ProcListing = {
      [k in ProcName]: Procedure<T['state'], Ty, I, O, E, Init>;
    };
    const newProcedure = { [procName]: procDef } as ProcListing;
    const procedures = {
      ...this.schema.procedures,
      ...newProcedure,
    } as {
      [Key in keyof (T['procedures'] & ProcListing)]: (T['procedures'] &
        ProcListing)[Key];
    };
    return new ServiceBuilder({
      ...this.schema,
      procedures,
    });
  }

  /**
   * Creates a new instance of ServiceBuilder.
   * @param {Name} name The name of the service.
   * @returns {ServiceBuilder<{ name: Name; state: {}; procedures: {}; }>} A new instance of ServiceBuilder.
   */
  static create<Name extends string>(
    name: Name,
  ): ServiceBuilder<{
    name: Name;
    state: object;
    procedures: ProcListing;
  }> {
    return new ServiceBuilder({
      name,
      state: {},
      procedures: {},
    });
  }
}
