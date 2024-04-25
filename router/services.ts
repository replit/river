import { TObject, Type, TUnion } from '@sinclair/typebox';
import { RiverUncaughtSchema } from './result';
import { Branded, ProcedureMap, Unbranded, AnyProcedure } from './procedures';

/**
 * An instantiated service, probably from a {@link ServiceSchema}.
 *
 * You shouldn't construct these directly, use {@link ServiceSchema} instead.
 */
export interface Service<
  State extends object,
  Procs extends ProcedureMap<State>,
> {
  readonly state: State;
  readonly procedures: Procs;
}

/**
 * Represents any {@link Service} object.
 */
export type AnyService = Service<object, ProcedureMap>;

/**
 * Represents any {@link ServiceSchema} object.
 */
export type AnyServiceSchema = ServiceSchema<object, ProcedureMap>;

/**
 * A dictionary of {@link ServiceSchema}s, where the key is the service name.
 */
export type ServiceSchemaMap = Record<string, AnyServiceSchema>;

/**
 * Takes a {@link ServiceSchemaMap} and returns a dictionary of instantiated
 * services.
 */
export type InstantiatedServiceSchemaMap<T extends ServiceSchemaMap> = {
  [K in keyof T]: T[K] extends ServiceSchema<infer S, infer P>
    ? Service<S, P>
    : never;
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
type BrandedProcedureMap<State> = Record<string, Branded<AnyProcedure<State>>>;

/**
 * The configuration for a service.
 */
export interface ServiceConfiguration<State extends object> {
  /**
   * A factory function for creating a fresh state.
   */
  initializeState: () => State;
}

/**
 * The schema for a {@link Service}. This is used to define a service, specifically
 * its initial state and procedures.
 *
 * There are two ways to define a service:
 * 1. the {@link ServiceSchema.define} static method, which takes a configuration and
 *    a list of procedures directly. Use this to ergonomically define a service schema
 *    in one go. Good for smaller services, especially if they're stateless.
 * 2. the {@link ServiceSchema.scaffold} static method, which creates a scaffold that
 *    can be used to define procedures separately from the configuration. Use this to
 *    better organize your service's definition, especially if it's a large service.
 *    You can also use it in a builder pattern to define the service in a more
 *    fluent way.
 *
 * See the static methods for more information and examples.
 *
 * When defining procedures, use the {@link Procedure} constructors to create them.
 */
export class ServiceSchema<
  State extends object,
  Procedures extends ProcedureMap<State>,
> {
  /**
   * Factory function for creating a fresh state.
   */
  protected readonly initializeState: () => State;

  /**
   * The procedures for this service.
   */
  readonly procedures: Procedures;

  /**
   * @param config - The configuration for this service.
   * @param procedures - The procedures for this service.
   */
  protected constructor(
    config: ServiceConfiguration<State>,
    procedures: Procedures,
  ) {
    this.initializeState = config.initializeState;
    this.procedures = procedures;
  }

  /**
   * Creates a {@link ServiceScaffold}, which can be used to define procedures
   * that can then be merged into a {@link ServiceSchema}, via the scaffold's
   * `finalize` method.
   *
   * There are two patterns that work well with this method. The first is using
   * it to separate the definition of procedures from the definition of the
   * service's configuration:
   * ```ts
   * const MyServiceScaffold = ServiceSchema.scaffold({
   *   initializeState: () => ({ count: 0 }),
   * });
   *
   * const incrementProcedures = MyServiceScaffold.procedures({
   *   increment: Procedure.rpc({
   *     input: Type.Object({ amount: Type.Number() }),
   *     output: Type.Object({ current: Type.Number() }),
   *     async handler(ctx, input) {
   *       ctx.state.count += input.amount;
   *       return Ok({ current: ctx.state.count });
   *     }
   *   }),
   * })
   *
   * const MyService = MyServiceScaffold.finalize({
   *   ...incrementProcedures,
   *   // you can also directly define procedures here
   * });
   * ```
   * This might be really handy if you have a very large service and you're
   * wanting to split it over multiple files. You can define the scaffold
   * in one file, and then import that scaffold in other files where you
   * define procedures - and then finally import the scaffolds and your
   * procedure objects in a final file where you finalize the scaffold into
   * a service schema.
   *
   * The other way is to use it like in a builder pattern:
   * ```ts
   * const MyService = ServiceSchema
   *   .scaffold({ initializeState: () => ({ count: 0 }) })
   *   .finalize({
   *     increment: Procedure.rpc({
   *       input: Type.Object({ amount: Type.Number() }),
   *       output: Type.Object({ current: Type.Number() }),
   *       async handler(ctx, input) {
   *         ctx.state.count += input.amount;
   *         return Ok({ current: ctx.state.count });
   *       }
   *     }),
   *   })
   * ```
   * Depending on your preferences, this may be a more appealing way to define
   * a schema versus using the {@link ServiceSchema.define} method.
   */
  static scaffold<State extends object>(config: ServiceConfiguration<State>) {
    return new ServiceScaffold(config);
  }

  /**
   * Creates a new {@link ServiceSchema} with the given configuration and procedures.
   *
   * All procedures must be created with the {@link Procedure} constructors.
   *
   * NOTE: There is an overload that lets you just provide the procedures alone if your
   * service has no state.
   *
   * @param config - The configuration for this service.
   * @param procedures - The procedures for this service.
   *
   * @example
   * ```
   * const service = ServiceSchema.define(
   *   { initializeState: () => ({ count: 0 }) },
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
  static define<
    State extends object,
    Procedures extends BrandedProcedureMap<State>,
  >(
    config: ServiceConfiguration<State>,
    procedures: Procedures,
  ): ServiceSchema<
    State,
    { [K in keyof Procedures]: Unbranded<Procedures[K]> }
  >;
  /**
   * Creates a new {@link ServiceSchema} with the given procedures.
   *
   * All procedures must be created with the {@link Procedure} constructors.
   *
   * NOTE: There is an overload that lets you provide configuration as well,
   * if your service has extra configuration like a state.
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
  static define<Procedures extends BrandedProcedureMap<Record<string, never>>>(
    procedures: Procedures,
  ): ServiceSchema<
    Record<string, never>,
    { [K in keyof Procedures]: Unbranded<Procedures[K]> }
  >;
  // actual implementation
  static define(
    configOrProcedures:
      | ServiceConfiguration<object>
      | BrandedProcedureMap<object>,
    maybeProcedures?: BrandedProcedureMap<object>,
  ): ServiceSchema<object, ProcedureMap> {
    let config: ServiceConfiguration<object>;
    let procedures: BrandedProcedureMap<object>;

    if (
      'initializeState' in configOrProcedures &&
      typeof configOrProcedures.initializeState === 'function'
    ) {
      if (!maybeProcedures) {
        throw new Error('Expected procedures to be defined');
      }

      config = configOrProcedures as ServiceConfiguration<object>;
      procedures = maybeProcedures;
    } else {
      config = { initializeState: () => ({}) };
      procedures = configOrProcedures as BrandedProcedureMap<object>;
    }

    return new ServiceSchema(config, procedures);
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
            // Only add `description` field if it is non-never.
            ...('description' in procDef
              ? {
                  description: Type.Strict(procDef.description),
                }
              : {}),
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
  instantiate(): Service<State, Procedures> {
    return Object.freeze({
      state: this.initializeState(),
      procedures: this.procedures,
    });
  }
}

/**
 * A scaffold for defining a service's procedures.
 *
 * @see {@link ServiceSchema.scaffold}
 */
// note that this isn't exported
class ServiceScaffold<State extends object> {
  /**
   * The configuration for this service.
   */
  protected readonly config: ServiceConfiguration<State>;

  /**
   * @param config - The configuration for this service.
   */
  constructor(config: ServiceConfiguration<State>) {
    this.config = config;
  }

  /**
   * Define procedures for this service. Use the {@link Procedure} constructors
   * to create them. This returns the procedures object, which can then be
   * passed to {@link ServiceSchema.finalize} to create a {@link ServiceSchema}.
   *
   * @example
   * ```
   * const myProcedures = MyServiceScaffold.procedures({
   *   myRPC: Procedure.rpc({
   *     // ...
   *   }),
   * });
   *
   * const MyService = MyServiceScaffold.finalize({
   *   ...myProcedures,
   * });
   * ```
   *
   * @param procedures - The procedures for this service.
   */
  procedures<T extends BrandedProcedureMap<State>>(procedures: T): T {
    return procedures;
  }

  /**
   * Finalizes the scaffold into a {@link ServiceSchema}. This is where you
   * provide the service's procedures and get a {@link ServiceSchema} in return.
   *
   * You can directly define procedures here, or you can define them separately
   * with the {@link ServiceScaffold.procedures} method, and then pass them here.
   *
   * @example
   * ```
   * const MyService = MyServiceScaffold.finalize({
   *  myRPC: Procedure.rpc({
   *   // ...
   *  }),
   *  // e.g. from the procedures method
   *  ...myOtherProcedures,
   * });
   * ```
   */
  finalize<T extends BrandedProcedureMap<State>>(
    procedures: T,
  ): ServiceSchema<State, { [K in keyof T]: Unbranded<T[K]> }> {
    return ServiceSchema.define(this.config, procedures);
  }
}
