import type { DescMethod, DescService } from '@bufbuild/protobuf';

// This fixture must preserve the inferred service shape from main at 0d136aa.
type MainMaybeDisposable<T extends object = Record<string, unknown>> = T & {
  [Symbol.asyncDispose]?: () => PromiseLike<void>;
  [Symbol.dispose]?: () => void;
};

interface MainRegisteredMethod {
  readonly service: DescService;
  readonly method: DescMethod;
  readonly impl: never;
}

interface MainInstantiatedProtoService {
  readonly descriptor: DescService;
  readonly state: MainMaybeDisposable<object>;
  readonly methods: ReadonlyMap<string, MainRegisteredMethod>;
  [Symbol.asyncDispose]: () => PromiseLike<void>;
}

export interface MainDefinedProtoService<
  Service extends DescService,
  Context extends object,
  State extends object,
> {
  readonly descriptor: Service;
  readonly methods: ReadonlyMap<string, MainRegisteredMethod>;
  readonly initializeStateFn:
    | ((ctx: Context) => MainMaybeDisposable<State>)
    | undefined;
  instantiate(ctx: Context): MainInstantiatedProtoService;
}
