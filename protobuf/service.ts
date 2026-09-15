import type {
  DescMethod,
  DescService,
  MessageInitShape,
} from '@bufbuild/protobuf';
import type {
  MethodImpl,
  ServiceImpl,
  ServiceImplWithRawHandlers,
} from './types';
import { decodeMessageBytes, encodeMessageBytes } from './shared';

/**
 * An object that may implement async or sync disposal.
 */
export type MaybeDisposable<T extends object = Record<string, unknown>> = T & {
  [Symbol.asyncDispose]?: () => PromiseLike<void>;
  [Symbol.dispose]?: () => void;
};

/**
 * Stored registration for a single protobuf method handler.
 */
export interface RegisteredMethod {
  readonly service: DescService;
  readonly method: DescMethod;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly impl: MethodImpl<DescMethod, any, any, any>;
}

/** Request decoding must return a protobuf message or a raw byte view. */
export interface MethodCodec {
  decodeRequest(bytes: Uint8Array): unknown;
  encodeResponse(payload: unknown): Uint8Array;
}

// Codec metadata must not change the public registration shape.
const methodCodecs = new WeakMap<RegisteredMethod, MethodCodec>();

function createTypedMethodCodec(method: DescMethod): MethodCodec {
  return {
    decodeRequest: (bytes) => decodeMessageBytes(method.input, bytes),
    encodeResponse: (payload) =>
      encodeMessageBytes(
        method.output,
        payload as MessageInitShape<typeof method.output>,
      ),
  };
}

export function getMethodCodec(registration: RegisteredMethod): MethodCodec {
  return (
    methodCodecs.get(registration) ??
    createTypedMethodCodec(registration.method)
  );
}

const rawMethodCodec: MethodCodec = {
  decodeRequest: (bytes) => bytes,
  encodeResponse(payload) {
    if (!(payload instanceof Uint8Array)) {
      throw new Error('raw protobuf handlers must return Uint8Array payloads');
    }

    return payload;
  },
};

/**
 * An instantiated protobuf service with initialized state and a disposal hook.
 */
export interface InstantiatedProtoService {
  readonly descriptor: DescService;
  readonly state: MaybeDisposable<object>;
  readonly methods: ReadonlyMap<string, RegisteredMethod>;
  [Symbol.asyncDispose]: () => PromiseLike<void>;
}

/**
 * Type-erased interface used by the server to interact with a
 * service definition without knowing its full generic signature.
 */
export interface AnyProtoService {
  readonly descriptor: DescService;
  readonly methods: ReadonlyMap<string, RegisteredMethod>;
  instantiate(ctx: object): InstantiatedProtoService;
}

interface ServiceConfiguration<Context extends object, State extends object> {
  initializeState: (ctx: Context) => MaybeDisposable<State>;
}

function buildMethodMap<
  Service extends DescService,
  Context extends object,
  State extends object,
  ParsedMetadata extends object,
>(
  descriptor: Service,
  handlers: ServiceImplWithRawHandlers<Service, Context, State, ParsedMetadata>,
): Map<string, RegisteredMethod> {
  const methods = new Map<string, RegisteredMethod>();
  const typedMethods = descriptor.method as Service['method'];

  for (const methodName of Object.keys(handlers) as Array<
    keyof typeof handlers & string
  >) {
    const handler = handlers[methodName];
    if (handler === undefined) {
      continue;
    }

    const method = typedMethods[methodName as keyof Service['method']] as
      | DescMethod
      | undefined;
    if (!method) {
      throw new Error(`unknown method ${methodName} on ${descriptor.typeName}`);
    }

    let impl: (...args: Array<never>) => unknown;
    let codec: MethodCodec;
    if (typeof handler === 'function') {
      impl = handler;
      codec = createTypedMethodCodec(method);
    } else {
      if (typeof handler.raw !== 'function') {
        throw new Error(
          `raw handler must be a function: ${descriptor.typeName}.${method.name}`,
        );
      }
      if (
        method.methodKind !== 'unary' &&
        method.methodKind !== 'server_streaming'
      ) {
        throw new Error(
          `raw handlers require a unary or server-streaming method: ${descriptor.typeName}.${method.name}`,
        );
      }
      impl = handler.raw;
      codec = rawMethodCodec;
    }

    const registration: RegisteredMethod = {
      service: descriptor,
      method,
      impl: impl as RegisteredMethod['impl'],
    };
    methodCodecs.set(registration, codec);
    methods.set(method.name, registration);
  }

  return methods;
}

/**
 * A scaffold for defining a protobuf service's handlers across multiple files.
 *
 * @see {@link ProtoServiceSchema.scaffold}
 */
class ProtoServiceScaffold<
  Service extends DescService,
  Context extends object,
  State extends object,
  ParsedMetadata extends object,
> {
  private readonly descriptor: Service;
  private readonly config: ServiceConfiguration<Context, State>;

  constructor(
    descriptor: Service,
    config: ServiceConfiguration<Context, State>,
  ) {
    this.descriptor = descriptor;
    this.config = config;
  }

  procedures(
    handlers: ServiceImpl<Service, Context, State, ParsedMetadata>,
  ): ServiceImpl<Service, Context, State, ParsedMetadata> {
    return handlers;
  }

  /**
   * Finalize the scaffold into a service definition. Provide all handlers
   * here (or spread in handler objects from {@link procedures}).
   *
   * @param handlers - Method implementations (missing methods return
   *   UNIMPLEMENTED at runtime).
   */
  finalize(handlers: ServiceImpl<Service, Context, State, ParsedMetadata>) {
    return createProtoService<Context, ParsedMetadata>().define(
      this.descriptor,
      this.config,
      handlers,
    );
  }
}

/**
 * Creates a factory for defining protobuf services with typed context and
 * metadata.
 *
 * This mirrors {@link createServiceSchema} from the TypeBox router. The
 * factory binds the `Context` and `ParsedMetadata` types, then provides
 * `.define()` and `.scaffold()` methods for creating service definitions.
 *
 * @example
 * ```ts
 * const ProtoService = createProtoService<AppContext, ParsedMetadata>();
 *
 * // all-in-one (stateless)
 * const testSvc = ProtoService.define(TestService, {
 *   echo: (req, ctx) => Ok({ text: req.text }),
 * });
 *
 * // all-in-one (with state)
 * const testSvc = ProtoService.define(
 *   TestService,
 *   { initializeState: (ctx) => ({ counter: 0 }) },
 *   {
 *     echo: (req, ctx) => {
 *       ctx.state.counter++;
 *       return Ok({ text: req.text });
 *     },
 *   },
 * );
 *
 * // scaffold for file-splitting
 * const scaffold = ProtoService.scaffold(TestService, {
 *   initializeState: (ctx) => ({ counter: 0 }),
 * });
 * const echoHandlers = scaffold.procedures({
 *   echo: (req, ctx) => Ok({ text: req.text }),
 * });
 * const testSvc = scaffold.finalize({
 *   ...echoHandlers,
 * });
 *
 * const server = createServer(transport, [testSvc], {
 *   context: myAppContext,
 * });
 * ```
 */
export function createProtoService<
  Context extends object = object,
  ParsedMetadata extends object = object,
>() {
  class ProtoServiceSchema<Service extends DescService, State extends object>
    implements AnyProtoService
  {
    readonly descriptor: Service;
    readonly methods: ReadonlyMap<string, RegisteredMethod>;

    /** @internal */
    readonly initializeStateFn:
      | ((ctx: Context) => MaybeDisposable<State>)
      | undefined;

    constructor(
      descriptor: Service,
      initializeStateFn: ((ctx: Context) => MaybeDisposable<State>) | undefined,
      methods: Map<string, RegisteredMethod>,
    ) {
      this.descriptor = descriptor;
      this.initializeStateFn = initializeStateFn;
      this.methods = methods;
    }

    /**
     * Create a live service instance with initialized state.
     *
     * @param ctx - The user-provided context, passed to `initializeState`.
     */
    instantiate(ctx: Context): InstantiatedProtoService {
      const state = this.initializeStateFn
        ? this.initializeStateFn(ctx)
        : ({} as MaybeDisposable<State>);

      return Object.freeze({
        descriptor: this.descriptor,
        state,
        methods: this.methods,
        async [Symbol.asyncDispose]() {
          await state[Symbol.asyncDispose]?.();
          state[Symbol.dispose]?.();
        },
      });
    }

    /**
     * Define a stateless protobuf service with the given handlers.
     *
     * @param descriptor - The generated protobuf service descriptor.
     * @param handlers - Method implementations (missing methods return
     *   UNIMPLEMENTED at runtime).
     */
    static define<S extends DescService>(
      descriptor: S,
      handlers: ServiceImpl<S, Context, object, ParsedMetadata>,
    ): ProtoServiceSchema<S, object>;
    /**
     * Define a stateful protobuf service with configuration and handlers.
     *
     * @param descriptor - The generated protobuf service descriptor.
     * @param config - Service configuration including `initializeState`.
     * @param handlers - Method implementations (missing methods return
     *   UNIMPLEMENTED at runtime).
     */
    static define<S extends DescService, St extends object>(
      descriptor: S,
      config: ServiceConfiguration<Context, St>,
      handlers: ServiceImpl<S, Context, St, ParsedMetadata>,
    ): ProtoServiceSchema<S, St>;
    static define<S extends DescService, St extends object>(
      descriptor: S,
      configOrHandlers:
        | ServiceConfiguration<Context, St>
        | ServiceImpl<S, Context, St, ParsedMetadata>,
      maybeHandlers?: ServiceImpl<S, Context, St, ParsedMetadata>,
    ): ProtoServiceSchema<S, St> {
      return defineService(descriptor, configOrHandlers, maybeHandlers);
    }

    static defineWithRawHandlers<S extends DescService>(
      descriptor: S,
      handlers: ServiceImplWithRawHandlers<S, Context, object, ParsedMetadata>,
    ): ProtoServiceSchema<S, object>;
    static defineWithRawHandlers<S extends DescService, St extends object>(
      descriptor: S,
      config: ServiceConfiguration<Context, St>,
      handlers: ServiceImplWithRawHandlers<S, Context, St, ParsedMetadata>,
    ): ProtoServiceSchema<S, St>;
    static defineWithRawHandlers<S extends DescService, St extends object>(
      descriptor: S,
      configOrHandlers:
        | ServiceConfiguration<Context, St>
        | ServiceImplWithRawHandlers<S, Context, St, ParsedMetadata>,
      maybeHandlers?: ServiceImplWithRawHandlers<
        S,
        Context,
        St,
        ParsedMetadata
      >,
    ): ProtoServiceSchema<S, St> {
      return defineService(descriptor, configOrHandlers, maybeHandlers);
    }

    /**
     * Create a scaffold for splitting handler implementations across files.
     *
     * @param descriptor - The generated protobuf service descriptor.
     * @param config - Service configuration including `initializeState`.
     */
    static scaffold<S extends DescService, St extends object>(
      descriptor: S,
      config: ServiceConfiguration<Context, St>,
    ) {
      return new ProtoServiceScaffold<S, Context, St, ParsedMetadata>(
        descriptor,
        config,
      );
    }
  }

  function defineService<S extends DescService, St extends object>(
    descriptor: S,
    configOrHandlers:
      | ServiceConfiguration<Context, St>
      | ServiceImplWithRawHandlers<S, Context, St, ParsedMetadata>,
    maybeHandlers?: ServiceImplWithRawHandlers<S, Context, St, ParsedMetadata>,
  ): ProtoServiceSchema<S, St> {
    let initializeStateFn: ((ctx: Context) => MaybeDisposable<St>) | undefined;
    let handlers: ServiceImplWithRawHandlers<S, Context, St, ParsedMetadata>;
    if (
      'initializeState' in configOrHandlers &&
      typeof configOrHandlers.initializeState === 'function'
    ) {
      if (!maybeHandlers) {
        throw new Error('expected handlers as third argument');
      }
      initializeStateFn = (
        configOrHandlers as ServiceConfiguration<Context, St>
      ).initializeState;
      handlers = maybeHandlers;
    } else {
      initializeStateFn = undefined;
      handlers = configOrHandlers as ServiceImplWithRawHandlers<
        S,
        Context,
        St,
        ParsedMetadata
      >;
    }

    return new ProtoServiceSchema(
      descriptor,
      initializeStateFn,
      buildMethodMap(descriptor, handlers),
    );
  }

  return ProtoServiceSchema;
}
