import { TObject, Type, TUnion } from '@sinclair/typebox';
import { RiverUncaughtSchema } from './result';
import { Branded, ProcListing, Unbranded, AnyProcedure } from './procedures';

/**
 * An instantiated service, probably from a {@link ServiceSchema}.
 *
 * You shouldn't construct these directly, use {@link ServiceSchema} instead.
 */
export interface Service<
  State extends object,
  Procs extends ProcListing<State>,
> {
  readonly state: State;
  readonly procedures: Procs;
}

/**
 * Represents any {@link Service} object.
 */
export type AnyService = Service<object, ProcListing>;

/**
 * Represents any {@link ServiceSchema} object.
 */
export type AnyServiceSchema = ServiceSchema<
  object,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Record<string, AnyProcedure<any>>
>;

/**
 * A dictionary of {@link Service}s, where the key is the service name.
 */
export type ServiceMap = Record<string, AnyService>;

/**
 * A dictionary of {@link ServiceSchema}s, where the key is the service name.
 */
export type ServiceSchemaMap = Record<string, AnyServiceSchema>;

/**
 * Takes a {@link ServiceSchemaMap} and returns a dictionary of instantiated
 * services, i.e. a {@link ServiceMap}.
 */
export type InstantiatedServiceSchemaMap<T extends ServiceSchemaMap> = {
  [K in keyof T]: ReturnType<T[K]['instantiate']>;
};

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

/**
 * A list of procedures where every procedure is "branded", as-in the procedure
 * was created via the {@link Procedure} constructors.
 */
type BrandedProcListing<State extends object> = Record<
  string,
  Branded<AnyProcedure<State>>
>;

/**
 * The schema for a {@link Service}. This is used to define a service, specifically
 * its initial state and procedures.
 *
 * Use the `define` static method to create a schema, and then use the `instantiate`
 * method to create a {@link Service}. Usually, instantiation is done for you, so
 * you shouldn't worry about it.
 *
 * When defining procedures, use the {@link Procedure} constructors to create them.
 *
 * @example
 * A service with no state:
 * ```
 * const service = ServiceSchema.define({
 *   add: Procedure.rpc({
 *     input: Type.Object({ a: Type.Number(), b: Type.Number() }),
 *     output: Type.Object({ result: Type.Number() }),
 *     async handler(ctx, input) {
 *       return Ok({ result: input.a + input.b });
 *     }
 *   }),
 * });
 *```
 * @example
 * A service with state:
 * ```
 * const service = ServiceSchema.define(
 *   () => ({ count: 0 }),
 *   {
 *     increment: Procedure.rpc({
 *       input: Type.Object({ amount: Type.Number() }),
 *       output: Type.Object({ current: Type.Number() }),
 *       async handler(ctx, input) {
 *         ctx.state.count += input.amount;
 *         return Ok({ current: ctx.state.count });
 *       }
 *     }),
 *   },
 * );
 * ```
 *
 */
export class ServiceSchema<
  State extends object,
  Procs extends ProcListing<State>,
> {
  /**
   * Factory function for creating a fresh state.
   */
  protected readonly initState: () => State;

  /**
   * The procedures for this service.
   */
  readonly procedures: Procs;

  /**
   * @param initState - A factory function for creating a fresh state.
   * @param procedures - The procedures for this service.
   */
  protected constructor(initState: () => State, procedures: Procs) {
    this.initState = initState;
    this.procedures = procedures;
  }

  /**
   * Creates a new {@link ServiceSchema} with the given state initializer and procedures.
   *
   * All procedures must be created with the {@link Procedure} constructors.
   *
   * NOTE: There is an overload that lets you just provide the procedures alone if your
   * service has no state.
   *
   * @param initState - A factory function for creating a fresh state.
   * @param procedures - The procedures for this service.
   *
   * @example
   * ```
   * const service = ServiceSchema.define(
   *   () => ({ count: 0 }),
   *   {
   *     increment: Procedure.rpc({
   *       input: Type.Object({ amount: Type.Number() }),
   *       output: Type.Object({ current: Type.Number() }),
   *       async handler(ctx, input) {
   *         ctx.state.count += input.amount;
   *         return Ok({ current: ctx.state.count });
   *       }
   *     }),
   *   },
   * );
   * ```
   */
  static define<State extends object, Procs extends BrandedProcListing<State>>(
    initState: () => State,
    procedures: Procs,
  ): ServiceSchema<State, { [K in keyof Procs]: Unbranded<Procs[K]> }>;
  /**
   * Creates a new {@link ServiceSchema} with the given procedures.
   *
   * All procedures must be created with the {@link Procedure} constructors.
   *
   * NOTE: There is an overload that lets you provide the state initializer as well,
   * if your service has state.
   *
   * @param procedures - The procedures for this service.
   *
   * @example
   * ```
   * const service = ServiceSchema.define({
   *   add: Procedure.rpc({
   *     input: Type.Object({ a: Type.Number(), b: Type.Number() }),
   *     output: Type.Object({ result: Type.Number() }),
   *     async handler(ctx, input) {
   *       return Ok({ result: input.a + input.b });
   *     }
   *   }),
   * });
   */
  static define<Procs extends BrandedProcListing<Record<string, never>>>(
    procedures: Procs,
  ): ServiceSchema<
    Record<string, never>,
    { [K in keyof Procs]: Unbranded<Procs[K]> }
  >;
  // actual implementation
  static define(
    stateOrProcedures: (() => object) | BrandedProcListing<object>,
    procedures?: BrandedProcListing<object>,
  ): ServiceSchema<object, ProcListing> {
    if (typeof stateOrProcedures === 'function') {
      if (!procedures) {
        throw new Error('Expected procedures to be defined');
      }

      return new ServiceSchema(() => stateOrProcedures(), procedures);
    }

    return new ServiceSchema(() => ({}), stateOrProcedures);
  }

  /**
   * Serializes this schema's procedures into a plain object that is JSON compatible.
   */
  serialize(): object {
    return {
      procedures: Object.fromEntries(
        Object.entries(this.procedures).map(([procName, procDef]) => [
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
   * Instantiates this schema into a {@link Service} object.
   *
   * You probably don't need this, usually the River server will handle this
   * for you.
   */
  instantiate(): Service<State, Procs> {
    return Object.freeze({
      state: this.initState(),
      procedures: this.procedures,
    });
  }
}
