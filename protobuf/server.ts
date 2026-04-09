import type {
  DescMethod,
  DescService,
  MessageInitShape,
  MessageShape,
} from '@bufbuild/protobuf';
import { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { context as otelContext, trace, type Span } from '@opentelemetry/api';
import { Logger } from '../logging';
import { ServerHandshakeOptions } from '../router/handshake';
import { Err, Ok, type Result } from '../router/result';
import { ReadableImpl, WritableImpl } from '../router/streams';
import { Connection } from '../transport/connection';
import { EventMap } from '../transport/events';
import {
  ControlFlags,
  ControlMessageCloseSchema,
  OpaqueTransportMessage,
  TransportClientId,
  cancelMessage,
  closeStreamMessage,
  isStreamCancel,
  isStreamClose,
  isStreamOpen,
} from '../transport/message';
import { ServerTransport } from '../transport/server';
import { coerceErrorString } from '../transport/stringifyError';
import type { SessionBoundSendFn } from '../transport/transport';
import type { IdentifiedSession } from '../transport/sessionStateMachine/common';
import {
  PropagationContext,
  createHandlerSpan,
  getTracer,
  recordRiverError,
} from '../tracing';
import type { ProtobufHandlerContext } from './context';
import {
  type ClientError,
  type ProtocolError,
  RiverErrorCode,
  isSerializedProtocolErrorResult,
} from './errors';
import {
  CANCEL_CODE,
  INVALID_REQUEST_CODE,
  UNCAUGHT_ERROR_CODE,
  UNEXPECTED_DISCONNECT_CODE,
} from '../router/errors';
import {
  decodeMessageBytes,
  encodeMessageBytes,
  methodKey,
  methodKindToProcType,
} from './shared';
import type {
  AnyProtoService,
  InstantiatedProtoService,
  MaybeDisposable,
  RegisteredMethod,
} from './service';

type StreamId = string;

type HandlerResponse<Method extends DescMethod> = Result<
  MessageInitShape<Method['output']>,
  ClientError
>;

interface StreamInitProps {
  readonly streamId: StreamId;
  readonly service: DescService;
  readonly method: DescMethod;
  readonly impl: RegisteredMethod['impl'];
  readonly serviceContext: object;
  readonly serviceState: object;
  readonly sessionMetadata: object;
  readonly initialSession: IdentifiedSession;
  readonly initialRequest: MessageShape<DescMethod['input']> | null;
  readonly closeRequestOnStart: boolean;
  readonly tracingCtx: PropagationContext | undefined;
}

interface ProcStream {
  readonly streamId: StreamId;
  readonly from: TransportClientId;
  readonly service: DescService;
  readonly method: DescMethod;
  readonly handleMsg: (msg: OpaqueTransportMessage) => void;
  readonly handleSessionDisconnect: () => void;
}

/**
 * Server instance for the protobuf router.
 */
export interface Server {
  readonly streams: Map<StreamId, ProcStream>;
  close(): Promise<void>;
}

/**
 * Context passed to protobuf middleware.
 */
export type MiddlewareContext<ParsedMetadata extends object = object> =
  Readonly<
    Omit<ProtobufHandlerContext<object, object, ParsedMetadata>, 'cancel'>
  > & {
    readonly streamId: StreamId;
    readonly procedureName: string;
    readonly serviceName: string;
  };

/**
 * Parameters passed to protobuf middleware.
 */
export interface MiddlewareParam<ParsedMetadata extends object = object> {
  readonly ctx: MiddlewareContext<ParsedMetadata>;
  readonly reqInit: MessageShape<DescMethod['input']> | null;
  next: () => void;
}

/**
 * Middleware is a function that can inspect protobuf requests as they are
 * received.
 */
export type Middleware<ParsedMetadata extends object = object> = (
  param: MiddlewareParam<ParsedMetadata>,
) => void;

/**
 * Options for creating a protobuf server.
 */
export interface ServerOptions<
  MetadataSchema extends TSchema,
  ParsedMetadata extends object,
> {
  readonly extendedContext?: object;
  readonly handshakeOptions?: ServerHandshakeOptions<
    MetadataSchema,
    ParsedMetadata
  >;
  readonly middlewares?: Array<Middleware<ParsedMetadata>>;
  readonly maxCancelledStreamTombstonesPerSession?: number;
}

class ProtobufServer<
  MetadataSchema extends TSchema,
  ParsedMetadata extends object,
> implements Server
{
  readonly streams: Map<StreamId, ProcStream>;

  private readonly transport: ServerTransport<
    Connection,
    MetadataSchema,
    ParsedMetadata
  >;

  private readonly methods: Map<string, RegisteredMethod>;
  private readonly serviceInstances: Map<string, InstantiatedProtoService>;
  private readonly userContext: object;

  private readonly log?: Logger;
  private readonly middlewares: Array<Middleware<ParsedMetadata>>;
  private readonly serverCancelledStreams: Map<
    TransportClientId,
    LRUSet<StreamId>
  >;

  private readonly maxCancelledStreamTombstonesPerSession: number;
  private unregisterTransportListeners: () => void;

  constructor(
    transport: ServerTransport<Connection, MetadataSchema, ParsedMetadata>,
    services: ReadonlyArray<AnyProtoService>,
    options: ServerOptions<MetadataSchema, ParsedMetadata> = {},
  ) {
    this.transport = transport;
    this.log = transport.log;
    this.middlewares = options.middlewares ?? [];
    this.maxCancelledStreamTombstonesPerSession =
      options.maxCancelledStreamTombstonesPerSession ?? 200;
    this.serverCancelledStreams = new Map();
    this.streams = new Map();
    this.userContext = options.extendedContext ?? {};

    // merge method registrations from all services
    this.methods = new Map();
    this.serviceInstances = new Map();

    for (const svc of services) {
      if (this.serviceInstances.has(svc.descriptor.typeName)) {
        throw new Error(
          `duplicate protobuf service registration for ${svc.descriptor.typeName}`,
        );
      }

      const instance = svc.instantiate(this.userContext);
      this.serviceInstances.set(svc.descriptor.typeName, instance);

      for (const [, reg] of instance.methods) {
        this.methods.set(
          methodKey(svc.descriptor.typeName, reg.method.name),
          reg,
        );
      }
    }

    if (options.handshakeOptions) {
      transport.extendHandshake(options.handshakeOptions);
    }

    const handleCreatingNewStreams = (message: EventMap['message']) => {
      if (message.to !== this.transport.clientId) {
        this.log?.info(
          `got msg with destination that isn't this server, ignoring`,
          {
            clientId: this.transport.clientId,
            transportMessage: message,
          },
        );

        return;
      }

      const stream = this.streams.get(message.streamId);
      if (stream) {
        stream.handleMsg(message);

        return;
      }

      if (
        this.serverCancelledStreams.get(message.from)?.has(message.streamId)
      ) {
        return;
      }

      const newStreamProps = this.validateNewProcStream(message);
      if (!newStreamProps) {
        return;
      }

      createHandlerSpan(
        transport.tracer,
        newStreamProps.initialSession,
        methodKindToProcType(newStreamProps.method.methodKind),
        newStreamProps.service.typeName,
        newStreamProps.method.name,
        newStreamProps.streamId,
        newStreamProps.tracingCtx,
        (span) => {
          this.createNewProcStream(span, newStreamProps);
        },
      );
    };

    const handleSessionStatus = (evt: EventMap['sessionStatus']) => {
      if (evt.status !== 'closing') {
        return;
      }

      const disconnectedClientId = evt.session.to;
      this.log?.info(
        `got session disconnect from ${disconnectedClientId}, cleaning up protobuf streams`,
        evt.session.loggingMetadata,
      );

      for (const stream of this.streams.values()) {
        if (stream.from === disconnectedClientId) {
          stream.handleSessionDisconnect();
        }
      }

      this.serverCancelledStreams.delete(disconnectedClientId);
    };

    const handleTransportStatus = (evt: EventMap['transportStatus']) => {
      if (evt.status === 'closed') {
        this.unregisterTransportListeners();
      }
    };

    this.unregisterTransportListeners = () => {
      this.transport.removeEventListener('message', handleCreatingNewStreams);
      this.transport.removeEventListener('sessionStatus', handleSessionStatus);
      this.transport.removeEventListener(
        'transportStatus',
        handleTransportStatus,
      );
    };

    this.transport.addEventListener('message', handleCreatingNewStreams);
    this.transport.addEventListener('sessionStatus', handleSessionStatus);
    this.transport.addEventListener('transportStatus', handleTransportStatus);
  }

  async close() {
    this.unregisterTransportListeners();

    for (const instance of this.serviceInstances.values()) {
      await instance[Symbol.asyncDispose]();
    }

    const ctx = this.userContext as MaybeDisposable;
    if (ctx[Symbol.asyncDispose]) {
      await ctx[Symbol.asyncDispose]?.();
    } else if (ctx[Symbol.dispose]) {
      ctx[Symbol.dispose]?.();
    } else {
      for (const value of Object.values(ctx)) {
        if (value && typeof value === 'object') {
          const v = value as MaybeDisposable;
          if (v[Symbol.asyncDispose]) {
            await v[Symbol.asyncDispose]?.();
          } else if (v[Symbol.dispose]) {
            v[Symbol.dispose]?.();
          }
        }
      }
    }
  }

  private createNewProcStream(span: Span, props: StreamInitProps) {
    const {
      streamId,
      service,
      method,
      impl,
      serviceContext,
      serviceState,
      sessionMetadata,
      initialSession,
      initialRequest,
      closeRequestOnStart,
    } = props;
    const { to: from, loggingMetadata, id: sessionId } = initialSession;

    loggingMetadata.telemetry = {
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
    };

    let cleanClose = true;
    const finishedController = new AbortController();
    const sessionScopedSend = this.transport.getSessionBoundSendFn(
      from,
      sessionId,
    );

    const deferredCleanups: Array<() => void | Promise<void>> = [];
    let cleanupsHaveRun = false;

    const runCleanupSafe = async (fn: () => void | Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        span.recordException(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    };

    const deferCleanup = (fn: () => void | Promise<void>) => {
      if (cleanupsHaveRun) {
        void runCleanupSafe(fn);

        return;
      }

      deferredCleanups.push(fn);
    };

    const runDeferredCleanups = async () => {
      if (deferredCleanups.length === 0) {
        cleanupsHaveRun = true;
        span.end();

        return;
      }

      const cleanupSpan = getTracer().startSpan(
        'river.cleanup',
        {},
        trace.setSpan(otelContext.active(), span),
      );

      try {
        for (let fn = deferredCleanups.pop(); fn; fn = deferredCleanups.pop()) {
          await runCleanupSafe(fn);
        }
      } finally {
        cleanupsHaveRun = true;
        cleanupSpan.end();
        span.end();
      }
    };

    const cleanup = () => {
      finishedController.abort();
      this.streams.delete(streamId);
      void runDeferredCleanups();
    };

    const reqReadable = new ReadableImpl<
      MessageShape<DescMethod['input']>,
      ProtocolError
    >();
    const closeReadable = () => {
      if (reqReadable.isClosed()) {
        return;
      }

      reqReadable._triggerClose();
      if (resWritable.isClosed()) {
        cleanup();
      }
    };

    const procClosesWithResponse =
      method.methodKind === 'unary' || method.methodKind === 'client_streaming';

    const resWritable = new WritableImpl<HandlerResponse<DescMethod>>({
      writeCb: (response) => {
        const payload = response.ok
          ? encodeMessageBytes(method.output, response.payload)
          : Err(response.payload);

        if (!response.ok) {
          recordRiverError(span, response.payload);
        }

        sessionScopedSend({
          streamId,
          controlFlags: procClosesWithResponse
            ? ControlFlags.StreamClosedBit
            : 0,
          payload,
        });

        if (procClosesWithResponse) {
          resWritable.close();
        }
      },
      closeCb: () => {
        if (!procClosesWithResponse && cleanClose) {
          sessionScopedSend(closeStreamMessage(streamId));
        }

        if (reqReadable.isClosed()) {
          cleanup();
        }
      },
    });

    const cancelStream = (error: ClientError) => {
      this.cancelStream(from, sessionScopedSend, streamId, error);
    };

    const pushRequestError = (error: ProtocolError) => {
      if (!reqReadable.isClosed()) {
        reqReadable._pushValue(Err(error));
        closeReadable();
      }

      resWritable.close();
    };

    const onServerCancel = (error: ProtocolError) => {
      recordRiverError(span, error);

      if (reqReadable.isClosed() && resWritable.isClosed()) {
        return;
      }

      cleanClose = false;
      pushRequestError(error);
      cancelStream(error);
    };

    const onHandlerError = (err: unknown) => {
      const errorMsg = coerceErrorString(err);

      span.recordException(err instanceof Error ? err : new Error(errorMsg));

      this.log?.error(
        `${service.typeName}.${method.name} handler threw an uncaught error`,
        {
          ...loggingMetadata,
          transportMessage: {
            procedureName: method.name,
            serviceName: service.typeName,
          },
          extras: {
            error: errorMsg,
            originalException: err,
          },
          tags: ['uncaught-handler-error'],
        },
      );

      const error: ClientError = {
        code: UNCAUGHT_ERROR_CODE,
        message: errorMsg,
      };
      recordRiverError(span, error);

      if (reqReadable.isClosed() && resWritable.isClosed()) {
        return;
      }

      if (!resWritable.isClosed()) {
        resWritable.write(Err(error));
        if (!procClosesWithResponse) {
          resWritable.close();
        }
      }

      if (!reqReadable.isClosed()) {
        closeReadable();
      }
    };

    const onMessage = (msg: OpaqueTransportMessage) => {
      if (msg.from !== from) {
        this.log?.error('got stream message from unexpected client', {
          ...loggingMetadata,
          transportMessage: msg,
          tags: ['invariant-violation'],
        });

        return;
      }

      if (isStreamCancel(msg.controlFlags)) {
        const error: ProtocolError = isSerializedProtocolErrorResult(
          msg.payload,
        )
          ? msg.payload.payload
          : {
              code: CANCEL_CODE,
              message: 'stream cancelled, client sent invalid payload',
            };

        pushRequestError(error);

        return;
      }

      if (reqReadable.isClosed()) {
        this.log?.warn('received message after request stream is closed', {
          ...loggingMetadata,
          transportMessage: msg,
          tags: ['invalid-request'],
        });
        onServerCancel({
          code: INVALID_REQUEST_CODE,
          message: 'received message after request stream is closed',
        });

        return;
      }

      if (msg.payload instanceof Uint8Array) {
        try {
          reqReadable._pushValue(
            Ok(decodeMessageBytes(method.input, msg.payload)),
          );
        } catch {
          onServerCancel({
            code: INVALID_REQUEST_CODE,
            message: 'failed to decode protobuf request payload',
          });

          return;
        }

        if (isStreamClose(msg.controlFlags)) {
          closeReadable();
        }

        return;
      }

      if (
        Value.Check(ControlMessageCloseSchema, msg.payload) &&
        isStreamClose(msg.controlFlags)
      ) {
        closeReadable();

        return;
      }

      onServerCancel({
        code: INVALID_REQUEST_CODE,
        message: 'received invalid protobuf request payload',
      });
    };

    const procStream: ProcStream = {
      from,
      streamId,
      service,
      method,
      handleMsg: onMessage,
      handleSessionDisconnect: () => {
        cleanClose = false;
        pushRequestError({
          code: UNEXPECTED_DISCONNECT_CODE,
          message: 'client unexpectedly disconnected',
        });
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const handlerContext: ProtobufHandlerContext<any, any, any> = {
      ...serviceContext,
      state: serviceState,
      from,
      sessionId,
      metadata: sessionMetadata,
      span,
      service,
      method,
      deferCleanup,
      cancel: (message?: string) => {
        const error: ProtocolError = {
          code: CANCEL_CODE,
          message: message ?? 'cancelled by server procedure handler',
        };
        onServerCancel(error);

        return Err(error);
      },
      signal: finishedController.signal,
    };

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const middlewareContext: MiddlewareContext<ParsedMetadata> = {
      ...handlerContext,
      streamId,
      procedureName: method.name,
      serviceName: service.typeName,
    };

    if (initialRequest !== null) {
      reqReadable._pushValue(Ok(initialRequest));
    }
    if (closeRequestOnStart) {
      closeReadable();
    }

    // type-erased handler dispatch; ProtoService.define() enforces the
    // correct handler signatures at registration time.
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
    const handler = impl as (...args: Array<any>) => any;

    const runProcedureHandler = async () => {
      try {
        switch (method.methodKind) {
          case 'unary': {
            const response: HandlerResponse<DescMethod> = await handler(
              requireInitialRequest(initialRequest, method),
              handlerContext,
            );
            if (!resWritable.isClosed()) {
              resWritable.write(response);
            }
            break;
          }

          case 'server_streaming':
            await handler({
              request: requireInitialRequest(initialRequest, method),
              ctx: handlerContext,
              resWritable,
            });
            break;

          case 'client_streaming': {
            const response: HandlerResponse<DescMethod> = await handler({
              ctx: handlerContext,
              reqReadable,
            });
            if (!resWritable.isClosed()) {
              resWritable.write(response);
            }
            break;
          }

          case 'bidi_streaming':
            await handler({
              ctx: handlerContext,
              reqReadable,
              resWritable,
            });
            break;
        }
      } catch (err) {
        onHandlerError(err);
      }
    };
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */

    this.middlewares.reduceRight(
      (next: () => void, middleware: Middleware<ParsedMetadata>) => {
        return () => {
          middleware({
            ctx: middlewareContext,
            reqInit: initialRequest,
            next,
          });
        };
      },
      () => {
        void runProcedureHandler();
      },
    )();

    if (!finishedController.signal.aborted) {
      this.streams.set(streamId, procStream);
    }
  }

  private validateNewProcStream(
    initMessage: OpaqueTransportMessage,
  ): StreamInitProps | null {
    const session = this.transport.sessions.get(initMessage.from);
    if (!session) {
      this.log?.error(`couldn't find session for ${initMessage.from}`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ['invariant-violation'],
      });

      return null;
    }

    const sessionScopedSend = this.transport.getSessionBoundSendFn(
      initMessage.from,
      session.id,
    );
    const sendCancel = (error: ClientError) => {
      this.cancelStream(
        initMessage.from,
        sessionScopedSend,
        initMessage.streamId,
        error,
      );
    };

    const sessionMetadata = this.transport.sessionHandshakeMetadata.get(
      session.to,
    );
    if (!sessionMetadata) {
      sendCancel({
        code: UNCAUGHT_ERROR_CODE,
        message: `session doesn't have handshake metadata`,
      });

      return null;
    }

    if (!isStreamOpen(initMessage.controlFlags)) {
      sendCancel({
        code: INVALID_REQUEST_CODE,
        message: `can't create a new procedure stream from a message without the stream open bit set`,
      });

      return null;
    }

    if (!initMessage.serviceName) {
      sendCancel({
        code: INVALID_REQUEST_CODE,
        message: `missing service name in stream open message`,
      });

      return null;
    }

    if (!initMessage.procedureName) {
      sendCancel({
        code: INVALID_REQUEST_CODE,
        message: `missing procedure name in stream open message`,
      });

      return null;
    }

    const route = this.methods.get(
      methodKey(initMessage.serviceName, initMessage.procedureName),
    );
    if (!route) {
      sendCancel({
        code: RiverErrorCode.UNIMPLEMENTED,
        message: `${initMessage.serviceName}.${initMessage.procedureName} is not implemented`,
      });

      return null;
    }

    const serviceInstance = this.serviceInstances.get(initMessage.serviceName);

    let initialRequest: MessageShape<DescMethod['input']> | null = null;
    let closeRequestOnStart = false;

    if (
      route.method.methodKind === 'unary' ||
      route.method.methodKind === 'server_streaming'
    ) {
      if (!(initMessage.payload instanceof Uint8Array)) {
        sendCancel({
          code: INVALID_REQUEST_CODE,
          message: 'expected protobuf request payload in opening frame',
        });

        return null;
      }

      try {
        initialRequest = decodeMessageBytes(
          route.method.input,
          initMessage.payload,
        );
      } catch {
        sendCancel({
          code: INVALID_REQUEST_CODE,
          message: 'failed to decode protobuf request payload',
        });

        return null;
      }

      if (!isStreamClose(initMessage.controlFlags)) {
        sendCancel({
          code: INVALID_REQUEST_CODE,
          message:
            'protobuf unary and server-streaming calls must close the request stream in the opening frame',
        });

        return null;
      }

      closeRequestOnStart = true;
    } else if (initMessage.payload instanceof Uint8Array) {
      if (initMessage.payload.byteLength > 0) {
        try {
          initialRequest = decodeMessageBytes(
            route.method.input,
            initMessage.payload,
          );
        } catch {
          sendCancel({
            code: INVALID_REQUEST_CODE,
            message: 'failed to decode protobuf request payload',
          });

          return null;
        }
      }

      closeRequestOnStart = isStreamClose(initMessage.controlFlags);
    } else if (
      Value.Check(ControlMessageCloseSchema, initMessage.payload) &&
      isStreamClose(initMessage.controlFlags)
    ) {
      closeRequestOnStart = true;
    } else {
      sendCancel({
        code: INVALID_REQUEST_CODE,
        message: 'received invalid protobuf request payload',
      });

      return null;
    }

    return {
      streamId: initMessage.streamId,
      service: route.service,
      method: route.method,
      impl: route.impl,
      serviceContext: this.userContext,
      serviceState: serviceInstance?.state ?? {},
      sessionMetadata,
      initialSession: session,
      initialRequest,
      closeRequestOnStart,
      tracingCtx: initMessage.tracing,
    };
  }

  private cancelStream(
    to: TransportClientId,
    sessionScopedSend: SessionBoundSendFn,
    streamId: StreamId,
    error: ClientError,
  ) {
    let cancelledStreamsInSession = this.serverCancelledStreams.get(to);
    if (!cancelledStreamsInSession) {
      cancelledStreamsInSession = new LRUSet(
        this.maxCancelledStreamTombstonesPerSession,
      );
      this.serverCancelledStreams.set(to, cancelledStreamsInSession);
    }

    cancelledStreamsInSession.add(streamId);
    sessionScopedSend(cancelMessage(streamId, Err(error)));
  }
}

function requireInitialRequest<Method extends DescMethod>(
  initialRequest: MessageShape<Method['input']> | null,
  method: Method,
): MessageShape<Method['input']> {
  if (initialRequest === null) {
    throw new Error(
      `missing initial request for protobuf ${method.parent.typeName}.${method.name}`,
    );
  }

  return initialRequest;
}

class LRUSet<T> {
  private readonly items = new Set<T>();

  constructor(private readonly maxItems: number) {}

  add(item: T) {
    if (this.items.has(item)) {
      this.items.delete(item);
    } else if (this.items.size >= this.maxItems) {
      const first = this.items.values().next();
      if (!first.done) {
        this.items.delete(first.value);
      }
    }

    this.items.add(item);
  }

  has(item: T) {
    return this.items.has(item);
  }
}

/**
 * Creates a protobuf server that listens on an existing River transport.
 *
 * @param transport - The server transport to listen on.
 * @param services - Array of {@link ProtoService} definitions.
 * @param options - Server options including context, handshake, and middleware.
 */
export function createServer<
  MetadataSchema extends TSchema,
  ParsedMetadata extends object,
>(
  transport: ServerTransport<Connection, MetadataSchema, ParsedMetadata>,
  services: ReadonlyArray<AnyProtoService>,
  options?: ServerOptions<MetadataSchema, ParsedMetadata>,
): Server {
  return new ProtobufServer(transport, services, options);
}
