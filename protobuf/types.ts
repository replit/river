import type {
  DescMethod,
  DescMethodBiDiStreaming,
  DescMethodClientStreaming,
  DescMethodServerStreaming,
  DescMethodUnary,
  DescService,
  MessageInitShape,
  MessageShape,
} from '@bufbuild/protobuf';
import type { Result } from '../router/result';
import type { Readable, Writable } from '../router/streams';
import type { ProtobufHandlerContext } from './context';
import type { ClientError, ProtocolError } from './errors';
import type { Codec } from '../codec/types';

type Awaitable<T> = T | PromiseLike<T>;

export type HandlerImpl<
  Kind extends DescMethod['methodKind'],
  Request,
  Response,
  Context extends object,
  State extends object,
  ParsedMetadata extends object,
> = Kind extends 'unary'
  ? (
      request: Request,
      ctx: ProtobufHandlerContext<Context, State, ParsedMetadata>,
    ) => Awaitable<Result<Response, ClientError>>
  : Kind extends 'server_streaming'
  ? (param: {
      readonly request: Request;
      readonly ctx: ProtobufHandlerContext<Context, State, ParsedMetadata>;
      readonly resWritable: Writable<Result<Response, ClientError>>;
    }) => Awaitable<void>
  : Kind extends 'client_streaming'
  ? (param: {
      readonly ctx: ProtobufHandlerContext<Context, State, ParsedMetadata>;
      readonly reqReadable: Readable<Request, ProtocolError>;
    }) => Awaitable<Result<Response, ClientError>>
  : Kind extends 'bidi_streaming'
  ? (param: {
      readonly ctx: ProtobufHandlerContext<Context, State, ParsedMetadata>;
      readonly reqReadable: Readable<Request, ProtocolError>;
      readonly resWritable: Writable<Result<Response, ClientError>>;
    }) => Awaitable<void>
  : never;

/**
 * Options shared by protobuf-router client calls.
 */
export interface CallOptions {
  readonly signal?: AbortSignal;
}

/**
 * The client-side surface for a client-streaming method.
 */
export interface ClientStreamingCall<Method extends DescMethodClientStreaming> {
  readonly reqWritable: Writable<MessageInitShape<Method['input']>>;
  readonly finalize: () => Promise<
    Result<MessageShape<Method['output']>, ClientError>
  >;
}

/**
 * The client-side surface for a bidi-streaming method.
 */
export interface BiDiStreamingCall<Method extends DescMethodBiDiStreaming> {
  readonly reqWritable: Writable<MessageInitShape<Method['input']>>;
  readonly resReadable: Readable<MessageShape<Method['output']>, ClientError>;
}

/**
 * A protobuf-router unary handler.
 */
export type UnaryImpl<
  Method extends DescMethodUnary,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = HandlerImpl<
  'unary',
  MessageShape<Method['input']>,
  MessageInitShape<Method['output']>,
  Context,
  State,
  ParsedMetadata
>;

/**
 * A protobuf-router server-streaming handler.
 */
export type ServerStreamingImpl<
  Method extends DescMethodServerStreaming,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = HandlerImpl<
  'server_streaming',
  MessageShape<Method['input']>,
  MessageInitShape<Method['output']>,
  Context,
  State,
  ParsedMetadata
>;

/**
 * A protobuf-router client-streaming handler.
 */
export type ClientStreamingImpl<
  Method extends DescMethodClientStreaming,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = HandlerImpl<
  'client_streaming',
  MessageShape<Method['input']>,
  MessageInitShape<Method['output']>,
  Context,
  State,
  ParsedMetadata
>;

/**
 * A protobuf-router bidi-streaming handler.
 */
export type BiDiStreamingImpl<
  Method extends DescMethodBiDiStreaming,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = HandlerImpl<
  'bidi_streaming',
  MessageShape<Method['input']>,
  MessageInitShape<Method['output']>,
  Context,
  State,
  ParsedMetadata
>;

/**
 * The handler type for an arbitrary protobuf method descriptor.
 */
export type MethodImpl<
  Method extends DescMethod,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = Method extends DescMethodUnary
  ? UnaryImpl<Method, Context, State, ParsedMetadata>
  : Method extends DescMethodServerStreaming
  ? ServerStreamingImpl<Method, Context, State, ParsedMetadata>
  : Method extends DescMethodClientStreaming
  ? ClientStreamingImpl<Method, Context, State, ParsedMetadata>
  : Method extends DescMethodBiDiStreaming
  ? BiDiStreamingImpl<Method, Context, State, ParsedMetadata>
  : never;

export type AnyCodec = Codec<unknown, never>;

declare const serdeTypes: unique symbol;

declare class SerdeHandlerBrand {
  // Object spread must not preserve the codec/handler pairing check.
  private readonly __BRAND_DO_NOT_USE: void;
}

export interface SerdeHandler<
  Kind extends DescMethod['methodKind'],
  Context extends object,
  State extends object,
  ParsedMetadata extends object,
> extends SerdeHandlerBrand {
  readonly input: AnyCodec;
  readonly output: AnyCodec;
  readonly handler: (...args: Array<never>) => unknown;
  readonly methodKind?: Kind;
  // Contextual inference must retain the slot's kind, context, state, and metadata.
  readonly [serdeTypes]?: {
    readonly kind: Kind;
    readonly context: (
      ctx: ProtobufHandlerContext<Context, State, ParsedMetadata>,
    ) => void;
  };
}

/**
 * All methods are optional -- missing methods return UNIMPLEMENTED at runtime.
 */
export type ServiceImpl<
  Service extends DescService,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = {
  [MethodName in keyof Service['method']]?: MethodImpl<
    Service['method'][MethodName] & DescMethod,
    Context,
    State,
    ParsedMetadata
  >;
};

export type ServiceImplWithSerde<
  Service extends DescService,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = {
  [MethodName in keyof Service['method']]?:
    | ServiceImpl<Service, Context, State, ParsedMetadata>[MethodName]
    | SerdeHandler<
        Service['method'][MethodName]['methodKind'],
        Context,
        State,
        ParsedMetadata
      >;
};

/**
 * The client surface for an arbitrary protobuf method descriptor.
 */
export type ClientMethod<Method extends DescMethod> =
  Method extends DescMethodUnary
    ? (
        request: MessageInitShape<Method['input']>,
        options?: CallOptions,
      ) => Promise<Result<MessageShape<Method['output']>, ClientError>>
    : Method extends DescMethodServerStreaming
    ? (
        request: MessageInitShape<Method['input']>,
        options?: CallOptions,
      ) => Readable<MessageShape<Method['output']>, ClientError>
    : Method extends DescMethodClientStreaming
    ? (options?: CallOptions) => ClientStreamingCall<Method>
    : Method extends DescMethodBiDiStreaming
    ? (options?: CallOptions) => BiDiStreamingCall<Method>
    : never;

/**
 * The generated client shape for a protobuf service descriptor.
 */
export type Client<Service extends DescService> = {
  [MethodName in keyof Service['method']]: Service['method'][MethodName] extends DescMethod
    ? ClientMethod<Service['method'][MethodName]>
    : never;
};
