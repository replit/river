import { Type, TSchema, Static, Kind } from '@sinclair/typebox';
import {
  Branded,
  ProcedureMap,
  Unbranded,
  AnyProcedure,
  PayloadType,
} from './procedures';
import {
  flattenErrorType,
  ProcedureErrorSchemaType,
  ReaderErrorSchema,
} from './errors';

/**
 * An instantiated service, probably from a {@link ServiceSchema}.
 *
 * You shouldn't construct these directly, use {@link ServiceSchema} instead.
 */
export interface Service<
  Context,
  State extends object,
  Procs extends ProcedureMap<Context, State>,
> {
  readonly state: State;
  readonly procedures: Procs;
  [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * Represents any {@link Service} object.
 */
export type AnyService = Service<object, object, ProcedureMap>;

/**
 * Represents any {@link ServiceSchema} object.
 */
export type AnyServiceSchema<Context extends object = object> = InstanceType<
  ReturnType<typeof createServiceSchema<Context>>
>;

/**
 * A dictionary of {@link ServiceSchema}s, where the key is the service name.
 */
export type AnyServiceSchemaMap<Context extends object = object> = Record<
  string,
  AnyServiceSchema<Context>
>;

// This has the secret sauce to keep go to definition working, the structure is
// somewhat delicate, so be careful when modifying it. Would be nice to add a
// static test for this.
/**
 * Takes a {@link AnyServiceSchemaMap} and returns a dictionary of instantiated
 * services.
 */
export type InstantiatedServiceSchemaMap<
  Context extends object,
  T extends AnyServiceSchemaMap<Context>,
> = {
  [K in keyof T]: T[K] extends AnyServiceSchema<Context>
    ? T[K] extends {
        initializeState: (ctx: Context) => infer S;
        procedures: infer P;
      }
      ? Service<
          Context,
          S extends object ? S : object,
          P extends ProcedureMap<Context, S extends object ? S : object>
            ? P
            : ProcedureMap
        >
      : never
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
 * Helper to get the type definition for the procedure init type of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcInit<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = Static<S['procedures'][ProcName]['requestInit']>;

/**
 * Helper to get the type definition for the procedure request of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcRequest<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName] extends { requestData: PayloadType }
  ? Static<S['procedures'][ProcName]['requestData']>
  : never;

/**
 * Helper to get the type definition for the procedure response of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcResponse<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = Static<S['procedures'][ProcName]['responseData']>;

/**
 * Helper to get the type definition for the procedure errors of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcErrors<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> =
  | Static<S['procedures'][ProcName]['responseError']>
  | Static<typeof ReaderErrorSchema>;

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
type BrandedProcedureMap<Context, State> = Record<
  string,
  Branded<AnyProcedure<Context, State>>
>;

type MaybeDisposable<State extends object> = State & {
  [Symbol.asyncDispose]?: () => Promise<void>;
  [Symbol.dispose]?: () => void;
};

/**
 * The configuration for a service.
 */
export interface ServiceConfiguration<
  Context extends object,
  State extends object,
> {
  /**
   * A factory function for creating a fresh state.
   */
  initializeState: (extendedContext: Context) => MaybeDisposable<State>;
}

// TODO remove once clients migrate to v2
export interface SerializedProcedureSchemaProtocolv1 {
  init?: PayloadType;
  input: PayloadType;
  output: PayloadType;
  errors?: ProcedureErrorSchemaType;
  type: 'rpc' | 'subscription' | 'upload' | 'stream';
}

// TODO remove once clients migrate to v2
export interface SerializedServiceSchemaProtocolv1 {
  procedures: Record<string, SerializedProcedureSchemaProtocolv1>;
}

// TODO remove once clients migrate to v2
export interface SerializedServerSchemaProtocolv1 {
  handshakeSchema?: TSchema;
  services: Record<string, SerializedServiceSchemaProtocolv1>;
}

/**
 * Omits compositing symbols from this schema.
 * The same approach that was previously used in the deprecated Type.Strict function.
 * https://github.com/sinclairzx81/typebox/blob/master/changelog/0.34.0.md#strict
 */
export function Strict<T extends TSchema>(schema: T): T {
  return JSON.parse(JSON.stringify(schema)) as T;
}

// TODO remove once clients migrate to v2
/**
 * Same as {@link serializeSchema} but with a format that is compatible with
 * protocolv1. This is useful to be able to continue to generate schemas for older
 * clients as they are still supported.
 */
export function serializeSchemaV1Compat(
  services: AnyServiceSchemaMap,
  handshakeSchema?: TSchema,
): SerializedServerSchemaProtocolv1 {
  const serializedServiceObject = Object.entries(services).reduce<
    Record<string, SerializedServiceSchemaProtocolv1>
  >((acc, [name, value]) => {
    acc[name] = value.serializeV1Compat();

    return acc;
  }, {});

  const schema: SerializedServerSchemaProtocolv1 = {
    services: serializedServiceObject,
  };

  if (handshakeSchema) {
    schema.handshakeSchema = Strict(handshakeSchema);
  }

  return schema;
}

export interface SerializedProcedureSchema {
  init: PayloadType;
  input?: PayloadType;
  output: PayloadType;
  errors?: ProcedureErrorSchemaType;
  type: 'rpc' | 'subscription' | 'upload' | 'stream';
}

export interface SerializedServiceSchema {
  procedures: Record<string, SerializedProcedureSchema>;
}

export interface SerializedServerSchema {
  handshakeSchema?: TSchema;
  services: Record<string, SerializedServiceSchema>;
}

/**
 * Serializes a server schema into a plain object that is JSON compatible.
 */
export function serializeSchema(
  services: AnyServiceSchemaMap,
  handshakeSchema?: TSchema,
): SerializedServerSchema {
  const serializedServiceObject = Object.entries(services).reduce<
    Record<string, SerializedServiceSchema>
  >((acc, [name, value]) => {
    acc[name] = value.serialize();

    return acc;
  }, {});

  const schema: SerializedServerSchema = {
    services: serializedServiceObject,
  };

  if (handshakeSchema) {
    schema.handshakeSchema = Strict(handshakeSchema);
  }

  return schema;
}

/**
 * Creates a ServiceSchema class that can be used to define services with their initial state and procedures.
 * This is a factory function that returns a ServiceSchema class constructor bound to the specified Context type.
 *
 * @template Context - The context type that will be available to all procedures in services created with this schema.
 * @returns A ServiceSchema class constructor with static methods for defining services.
 *
 * @example
 * ```ts
 * // Create a ServiceSchema class for your context type
 * const ServiceSchema = createServiceSchema<{ userId: string }>();
 *
 * // Define a simple stateless service
 * const mathService = ServiceSchema.define({
 *   add: Procedure.rpc({
 *     requestInit: Type.Object({ a: Type.Number(), b: Type.Number() }),
 *     responseData: Type.Object({ result: Type.Number() }),
 *     async handler(ctx, init) {
 *       return Ok({ result: init.a + init.b });
 *     }
 *   }),
 * });
 * ```
 *
 * There are two main ways to define services with the returned ServiceSchema class:
 *
 * 1. **ServiceSchema.define()** - Takes a configuration and procedures directly.
 *    Use this for smaller services or when you want to define everything in one place.
 *
 * 2. **ServiceSchema.scaffold()** - Creates a scaffold that can be used to define
 *    procedures separately from the configuration. Use this for larger services or
 *    when you want to organize procedures across multiple files.
 *
 * When defining procedures, always use the {@link Procedure} constructors to create them.
 */
export function createServiceSchema<Context extends object>(
  context = {} as Context,
) {
  return class ServiceSchema<
    State extends object,
    Procedures extends ProcedureMap<Context, State>,
  > {
    /**
     * Factory function for creating a fresh state.
     */
    readonly initializeState: (
      extendedContext: Context,
    ) => MaybeDisposable<State>;

    /**
     * The procedures for this service.
     */
    readonly procedures: Procedures;

    /**
     * @param config - The configuration for this service.
     * @param procedures - The procedures for this service.
     */
    constructor(
      config: ServiceConfiguration<Context, State>,
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
     *     requestInit: Type.Object({ amount: Type.Number() }),
     *     responseData: Type.Object({ current: Type.Number() }),
     *     async handler(ctx, init) {
     *       ctx.state.count += init.amount;
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
     *       requestInit: Type.Object({ amount: Type.Number() }),
     *       responseData: Type.Object({ current: Type.Number() }),
     *       async handler(ctx, init) {
     *         ctx.state.count += init.amount;
     *         return Ok({ current: ctx.state.count });
     *       }
     *     }),
     *   })
     * ```
     * Depending on your preferences, this may be a more appealing way to define
     * a schema versus using the {@link ServiceSchema.define} method.
     */
    static scaffold<State extends object>(
      config: ServiceConfiguration<Context, State>,
    ) {
      return new ServiceScaffold(config, context);
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
     *       requestInit: Type.Object({ amount: Type.Number() }),
     *       responseData: Type.Object({ current: Type.Number() }),
     *       async handler(ctx, init) {
     *         ctx.state.count += init.amount;
     *         return Ok({ current: ctx.state.count });
     *       }
     *     }),
     *   },
     * );
     * ```
     */
    static define<
      State extends object,
      Procedures extends BrandedProcedureMap<Context, State>,
    >(
      config: ServiceConfiguration<Context, State>,
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
     *     requestInit: Type.Object({ a: Type.Number(), b: Type.Number() }),
     *     responseData: Type.Object({ result: Type.Number() }),
     *     async handler(ctx, init) {
     *       return Ok({ result: init.a + init.b });
     *     }
     *   }),
     * });
     */

    static define<Procedures extends BrandedProcedureMap<Context, object>>(
      procedures: Procedures,
    ): ServiceSchema<
      object,
      { [K in keyof Procedures]: Unbranded<Procedures[K]> }
    >;
    // actual implementation
    static define(
      configOrProcedures:
        | ServiceConfiguration<Context, object>
        | BrandedProcedureMap<Context, object>,
      maybeProcedures?: BrandedProcedureMap<Context, object>,
    ): ServiceSchema<object, ProcedureMap> {
      let config: ServiceConfiguration<Context, object>;
      let procedures: BrandedProcedureMap<Context, object>;

      if (
        'initializeState' in configOrProcedures &&
        typeof configOrProcedures.initializeState === 'function'
      ) {
        if (!maybeProcedures) {
          throw new Error('Expected procedures to be defined');
        }

        config = configOrProcedures as ServiceConfiguration<Context, object>;
        procedures = maybeProcedures;
      } else {
        config = { initializeState: () => ({}) };
        procedures = configOrProcedures as BrandedProcedureMap<Context, object>;
      }

      return new ServiceSchema(config, procedures);
    }

    /**
     * Serializes this schema's procedures into a plain object that is JSON compatible.
     */
    serialize(): SerializedServiceSchema {
      return {
        procedures: Object.fromEntries(
          Object.entries(this.procedures).map(([procName, procDef]) => [
            procName,
            {
              init: Strict(procDef.requestInit),
              output: Strict(procDef.responseData),
              errors: getSerializedProcErrors(procDef),
              // Only add `description` field if the type declares it.
              ...('description' in procDef
                ? { description: procDef.description }
                : {}),
              type: procDef.type,
              // Only add the `input` field if the type declares it.
              ...('requestData' in procDef
                ? {
                    input: Strict(procDef.requestData),
                  }
                : {}),
            },
          ]),
        ),
      };
    }

    // TODO remove once clients migrate to v2
    /**
     * Same as {@link ServiceSchema.serialize}, but with a format that is compatible with
     * protocol v1. This is useful to be able to continue to generate schemas for older
     * clients as they are still supported.
     */
    serializeV1Compat(): SerializedServiceSchemaProtocolv1 {
      return {
        procedures: Object.fromEntries(
          Object.entries(this.procedures).map(
            ([procName, procDef]): [
              string,
              SerializedProcedureSchemaProtocolv1,
            ] => {
              if (procDef.type === 'rpc' || procDef.type === 'subscription') {
                return [
                  procName,
                  {
                    // BACKWARDS COMPAT: map init to input for protocolv1
                    // this is the only change needed to make it compatible.
                    input: Strict(procDef.requestInit),
                    output: Strict(procDef.responseData),
                    errors: getSerializedProcErrors(procDef),
                    // Only add `description` field if the type declares it.
                    ...('description' in procDef
                      ? { description: procDef.description }
                      : {}),
                    type: procDef.type,
                  },
                ];
              }

              // No backwards compatibility needed for upload and stream types, as having an `init`
              // all the time is compatible with protocol v1.
              return [
                procName,
                {
                  init: Strict(procDef.requestInit),
                  output: Strict(procDef.responseData),
                  errors: getSerializedProcErrors(procDef),
                  // Only add `description` field if the type declares it.
                  ...('description' in procDef
                    ? { description: procDef.description }
                    : {}),
                  type: procDef.type,
                  input: Strict(procDef.requestData),
                },
              ];
            },
          ),
        ),
      };
    }

    /**
     * Instantiates this schema into a {@link Service} object.
     *
     * You probably don't need this, usually the River server will handle this
     * for you.
     */
    instantiate(extendedContext: Context): Service<Context, State, Procedures> {
      const state = this.initializeState(extendedContext);
      const dispose = async () => {
        await state[Symbol.asyncDispose]?.();
        state[Symbol.dispose]?.();
      };

      return Object.freeze({
        state,
        procedures: this.procedures,
        [Symbol.asyncDispose]: dispose,
      });
    }
  };
}

export function getSerializedProcErrors(
  procDef: AnyProcedure,
): ProcedureErrorSchemaType {
  if (
    !('responseError' in procDef) ||
    procDef.responseError[Kind] === 'Never'
  ) {
    return Strict(ReaderErrorSchema);
  }

  const withProtocolErrors = flattenErrorType(
    Type.Union([procDef.responseError, ReaderErrorSchema]),
  );

  return Strict(withProtocolErrors);
}

/**
 * A scaffold for defining a service's procedures.
 *
 * @see {@link ServiceSchema.scaffold}
 */
// note that this isn't exported
class ServiceScaffold<Context extends object, State extends object> {
  /**
   * The configuration for this service.
   */
  protected readonly config: ServiceConfiguration<Context, State>;

  protected readonly context: Context;

  /**
   * @param config - The configuration for this service.
   */
  constructor(config: ServiceConfiguration<Context, State>, context: Context) {
    this.config = config;
    this.context = context;
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
  procedures<T extends BrandedProcedureMap<Context, State>>(procedures: T): T {
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
  finalize<T extends BrandedProcedureMap<Context, State>>(procedures: T) {
    return createServiceSchema(this.context).define(this.config, procedures);
  }
}
