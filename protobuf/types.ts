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

type Awaitable<T> = T | PromiseLike<T>;

type HandlerResult<Method extends DescMethod> = Result<
  MessageInitShape<Method['output']>,
  ClientError
>;

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
> = (
  request: MessageShape<Method['input']>,
  ctx: ProtobufHandlerContext<Context, State, ParsedMetadata>,
) => Awaitable<HandlerResult<Method>>;

/**
 * A protobuf-router server-streaming handler.
 */
export type ServerStreamingImpl<
  Method extends DescMethodServerStreaming,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = (param: {
  readonly request: MessageShape<Method['input']>;
  readonly ctx: ProtobufHandlerContext<Context, State, ParsedMetadata>;
  readonly resWritable: Writable<HandlerResult<Method>>;
}) => Awaitable<void>;

/**
 * A protobuf-router client-streaming handler.
 */
export type ClientStreamingImpl<
  Method extends DescMethodClientStreaming,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = (param: {
  readonly ctx: ProtobufHandlerContext<Context, State, ParsedMetadata>;
  readonly reqReadable: Readable<MessageShape<Method['input']>, ProtocolError>;
}) => Awaitable<HandlerResult<Method>>;

/**
 * A protobuf-router bidi-streaming handler.
 */
export type BiDiStreamingImpl<
  Method extends DescMethodBiDiStreaming,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = (param: {
  readonly ctx: ProtobufHandlerContext<Context, State, ParsedMetadata>;
  readonly reqReadable: Readable<MessageShape<Method['input']>, ProtocolError>;
  readonly resWritable: Writable<HandlerResult<Method>>;
}) => Awaitable<void>;

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

type RawMethodImpl<
  Method extends DescMethod,
  Request,
  HandlerContext,
> = Method extends DescMethodUnary
  ? (
      request: Request,
      ctx: HandlerContext,
    ) => Awaitable<Result<Uint8Array, ClientError>>
  : Method extends DescMethodServerStreaming
  ? (param: {
      readonly request: Request;
      readonly ctx: HandlerContext;
      readonly resWritable: Writable<Result<Uint8Array, ClientError>>;
    }) => Awaitable<void>
  : Method extends DescMethodClientStreaming
  ? (param: {
      readonly ctx: HandlerContext;
      readonly reqReadable: Readable<Request, ProtocolError>;
    }) => Awaitable<Result<Uint8Array, ClientError>>
  : Method extends DescMethodBiDiStreaming
  ? (param: {
      readonly ctx: HandlerContext;
      readonly reqReadable: Readable<Request, ProtocolError>;
      readonly resWritable: Writable<Result<Uint8Array, ClientError>>;
    }) => Awaitable<void>
  : never;

/** A raw handler owns protobuf-body validation; River still validates the envelope. */
export type RawHandler<
  Method extends DescMethod,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> =
  | {
      readonly raw: 'both';
      readonly handler: RawMethodImpl<
        Method,
        Uint8Array,
        ProtobufHandlerContext<Context, State, ParsedMetadata>
      >;
    }
  | {
      readonly raw: 'output';
      readonly handler: RawMethodImpl<
        Method,
        MessageShape<Method['input']>,
        ProtobufHandlerContext<Context, State, ParsedMetadata>
      >;
    };

/**
 * Partial implementation shape for a protobuf service.
 *
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

export type ServiceImplWithRawHandlers<
  Service extends DescService,
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = {
  [MethodName in keyof Service['method']]?:
    | ServiceImpl<Service, Context, State, ParsedMetadata>[MethodName]
    | RawHandler<
        Service['method'][MethodName] & DescMethod,
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
