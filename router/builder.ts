import { TObject, Static, Type } from '@sinclair/typebox';
import type { Pushable } from 'it-pushable';
import { TransportMessage } from '../transport/message';
import { ServiceContextWithState } from './context';

/**
 * The valid {@link Procedure} types.
 */
export type ValidProcType = 'stream' | 'rpc';

/**
 * A generic procedure listing where the keys are the names of the procedures
 * and the values are the {@link Procedure} definitions. This is not meant to
 * be constructed directly, use the {@link ServiceBuilder} class instead.
 */
export type ProcListing = Record<
  string,
  Procedure<object, ValidProcType, TObject, TObject>
>;

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
export type AnyService = Service<string, object, any>;

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
      Object.entries<Procedure<object, ValidProcType, TObject, TObject>>(
        s.procedures,
      ).map(([procName, procDef]) => [
        procName,
        {
          input: Type.Strict(procDef.input),
          output: Type.Strict(procDef.output),
          type: procDef.type,
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
 * Helper to get the type of procedure in a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcType<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['type'];

/**
 * Defines a Procedure type that can be either an RPC or a stream procedure.
 * @template State - The TypeBox schema of the state object.
 * @template Ty - The type of the procedure, either 'rpc' or 'stream'.
 * @template I - The TypeBox schema of the input object.
 * @template O - The TypeBox schema of the output object.
 */
export type Procedure<
  State extends object | unknown,
  Ty extends ValidProcType,
  I extends TObject,
  O extends TObject,
> = Ty extends 'rpc'
  ? {
      input: I;
      output: O;
      handler: (
        context: ServiceContextWithState<State>,
        input: TransportMessage<Static<I>>,
      ) => Promise<TransportMessage<Static<O>>>;
      type: Ty;
    }
  : {
      input: I;
      output: O;
      handler: (
        context: ServiceContextWithState<State>,
        input: AsyncIterable<TransportMessage<Static<I>>>,
        output: Pushable<TransportMessage<Static<O>>>,
      ) => Promise<void>;
      type: Ty;
    };

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
   * @returns {T} The finalized schema for the service.
   */
  finalize(): T {
    return this.schema;
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
   * @param {Procedure<T['state'], Ty, I, O>} procDef The definition of the procedure.
   * @returns {ServiceBuilder<{ name: T['name']; state: T['state']; procedures: T['procedures'] & { [k in ProcName]: Procedure<T['state'], Ty, I, O>; }; }>} A new ServiceBuilder instance with the updated schema.
   */
  defineProcedure<
    ProcName extends string,
    Ty extends ValidProcType,
    I extends TObject,
    O extends TObject,
  >(
    procName: ProcName,
    procDef: Procedure<T['state'], Ty, I, O>,
  ): ServiceBuilder<{
    name: T['name'];
    state: T['state'];
    procedures: T['procedures'] & {
      [k in ProcName]: Procedure<T['state'], Ty, I, O>;
    };
  }> {
    type ProcListing = { [k in ProcName]: Procedure<T['state'], Ty, I, O> };
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
    state: {};
    procedures: {};
  }> {
    return new ServiceBuilder({
      name,
      state: {},
      procedures: {},
    });
  }
}
