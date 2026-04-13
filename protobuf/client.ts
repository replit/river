import type {
  DescMethod,
  DescMethodBiDiStreaming,
  DescMethodClientStreaming,
  DescService,
  MessageInitShape,
  MessageShape,
} from '@bufbuild/protobuf';
import { Value } from '@sinclair/typebox/value';
import { ClientTransport } from '../transport/client';
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
} from '../transport/message';
import { generateId } from '../transport/id';
import { ClientHandshakeOptions } from '../router/handshake';
import { Err, Ok, type Result } from '../router/result';
import {
  Readable,
  ReadableBrokenError,
  ReadableImpl,
  WritableImpl,
} from '../router/streams';
import { Logger } from '../logging';
import { createProcTelemetryInfo, getPropagationContext } from '../tracing';
import { type ClientError, isSerializedClientErrorResult } from './errors';
import {
  CANCEL_CODE,
  INVALID_REQUEST_CODE,
  UNEXPECTED_DISCONNECT_CODE,
} from '../router/errors';
import {
  EMPTY_PROTO_BYTES,
  decodeMessageBytes,
  encodeMessageBytes,
  methodKindToProcType,
} from './shared';
import type {
  BiDiStreamingCall,
  CallOptions,
  Client as ProtobufClient,
  ClientMethod,
  ClientStreamingCall,
} from './types';

/**
 * Options for the protobuf client.
 */
export interface ClientOptions {
  readonly connectOnInvoke: boolean;
  readonly eagerlyConnect: boolean;
}

const defaultClientOptions: ClientOptions = {
  connectOnInvoke: true,
  eagerlyConnect: true,
};

interface StartedMethodCall<
  InputDesc extends DescMethod['input'],
  OutputDesc extends DescMethod['output'],
> {
  readonly reqWritable: WritableImpl<MessageInitShape<InputDesc>>;
  readonly resReadable: ReadableImpl<MessageShape<OutputDesc>, ClientError>;
}

/**
 * Creates a protobuf client for a single protobuf service descriptor.
 */
export function createClient<Service extends DescService>(
  service: Service,
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  providedClientOptions: Partial<
    ClientOptions & {
      handshakeOptions: ClientHandshakeOptions;
    }
  > = {},
): ProtobufClient<Service> {
  if (providedClientOptions.handshakeOptions) {
    transport.extendHandshake(providedClientOptions.handshakeOptions);
  }

  const clientOptions = { ...defaultClientOptions, ...providedClientOptions };
  if (clientOptions.eagerlyConnect) {
    transport.connect(serverId);
  }

  const client: Partial<Record<keyof Service['method'], unknown>> = {};
  for (const methodName of Object.keys(service.method) as Array<
    keyof Service['method']
  >) {
    const method = (service.method as Service['method'])[methodName];
    client[methodName] = createMethodCaller(
      service,
      method,
      transport,
      serverId,
      clientOptions,
    );
  }

  return client as ProtobufClient<Service>;
}

function createMethodCaller<Method extends DescMethod>(
  service: DescService,
  method: Method,
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  clientOptions: ClientOptions,
): ClientMethod<Method> {
  switch (method.methodKind) {
    case 'unary':
      return ((
        request: MessageInitShape<Method['input']>,
        options?: CallOptions,
      ) => {
        if (transport.getStatus() === 'closed') {
          return Promise.resolve(
            Err({
              code: UNEXPECTED_DISCONNECT_CODE,
              message: 'transport is closed',
            }),
          );
        }

        connectOnInvokeIfNeeded(clientOptions, transport, serverId);
        const { resReadable } = startMethodCall(
          service,
          method,
          transport,
          serverId,
          encodeMessageBytes(method.input, request),
          true,
          options?.signal,
        );

        return getSingleMessage(resReadable, transport.log);
      }) as unknown as ClientMethod<Method>;

    case 'server_streaming':
      return ((
        request: MessageInitShape<Method['input']>,
        options?: CallOptions,
      ) => {
        if (transport.getStatus() === 'closed') {
          return createPreClosedReadable<MessageShape<Method['output']>>({
            code: UNEXPECTED_DISCONNECT_CODE,
            message: 'transport is closed',
          });
        }

        connectOnInvokeIfNeeded(clientOptions, transport, serverId);

        return startMethodCall(
          service,
          method,
          transport,
          serverId,
          encodeMessageBytes(method.input, request),
          true,
          options?.signal,
        ).resReadable;
      }) as unknown as ClientMethod<Method>;

    case 'client_streaming':
      return ((options?: CallOptions) => {
        if (transport.getStatus() === 'closed') {
          return createPreClosedClientStreamingCall<
            MessageInitShape<Method['input']>,
            MessageShape<Method['output']>
          >();
        }

        connectOnInvokeIfNeeded(clientOptions, transport, serverId);
        const { reqWritable, resReadable } = startMethodCall(
          service,
          method,
          transport,
          serverId,
          EMPTY_PROTO_BYTES,
          false,
          options?.signal,
        );

        let didFinalize = false;

        return {
          reqWritable,
          finalize: () => {
            if (didFinalize) {
              throw new Error('client streaming call already finalized');
            }

            didFinalize = true;
            if (!reqWritable.isClosed()) {
              reqWritable.close();
            }

            return getSingleMessage(resReadable, transport.log);
          },
        } satisfies ClientStreamingCall<DescMethodClientStreaming>;
      }) as unknown as ClientMethod<Method>;

    case 'bidi_streaming':
      return ((options?: CallOptions) => {
        if (transport.getStatus() === 'closed') {
          return createPreClosedBiDiStreamingCall<
            MessageInitShape<Method['input']>,
            MessageShape<Method['output']>
          >();
        }

        connectOnInvokeIfNeeded(clientOptions, transport, serverId);

        return startMethodCall(
          service,
          method,
          transport,
          serverId,
          EMPTY_PROTO_BYTES,
          false,
          options?.signal,
        ) satisfies BiDiStreamingCall<DescMethodBiDiStreaming>;
      }) as unknown as ClientMethod<Method>;
  }
}

function connectOnInvokeIfNeeded(
  clientOptions: ClientOptions,
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
) {
  if (clientOptions.connectOnInvoke && !transport.sessions.has(serverId)) {
    transport.connect(serverId);
  }
}

function startMethodCall<Method extends DescMethod>(
  service: DescService,
  method: Method,
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  initialPayload: Uint8Array,
  procClosesWithInit: boolean,
  abortSignal?: AbortSignal,
): StartedMethodCall<Method['input'], Method['output']> {
  const session =
    transport.sessions.get(serverId) ??
    transport.createUnconnectedSession(serverId);
  const sessionScopedSend = transport.getSessionBoundSendFn(
    serverId,
    session.id,
  );

  const streamId = generateId();
  const { span, ctx } = createProcTelemetryInfo(
    transport.tracer,
    session,
    methodKindToProcType(method.methodKind),
    service.typeName,
    method.name,
    streamId,
  );

  let cleanClose = true;
  const reqWritable = new WritableImpl<MessageInitShape<Method['input']>>({
    writeCb: (value) => {
      sessionScopedSend({
        streamId,
        payload: encodeMessageBytes(method.input, value),
        controlFlags: 0,
      });
    },
    closeCb: () => {
      span.addEvent('reqWritable closed');

      if (!procClosesWithInit && cleanClose) {
        sessionScopedSend(closeStreamMessage(streamId));
      }

      if (resReadable.isClosed()) {
        cleanup();
      }
    },
  });

  const resReadable = new ReadableImpl<
    MessageShape<Method['output']>,
    ClientError
  >();
  const closeReadable = () => {
    if (resReadable.isClosed()) {
      return;
    }

    resReadable._triggerClose();
    span.addEvent('resReadable closed');

    if (reqWritable.isClosed()) {
      cleanup();
    }
  };

  function cleanup() {
    transport.removeEventListener('message', onMessage);
    transport.removeEventListener('sessionStatus', onSessionStatus);
    abortSignal?.removeEventListener('abort', onClientCancel);
    span.end();
  }

  function pushResponseError(error: ClientError) {
    if (!resReadable.isClosed()) {
      resReadable._pushValue(Err(error));
      closeReadable();
    }

    reqWritable.close();
  }

  function onClientCancel() {
    if (resReadable.isClosed() && reqWritable.isClosed()) {
      return;
    }

    span.addEvent('sending cancel');
    cleanClose = false;

    const error: ClientError = {
      code: CANCEL_CODE,
      message: 'cancelled by client',
    };
    pushResponseError(error);
    sessionScopedSend(cancelMessage(streamId, Err(error)));
  }

  function onMessage(msg: OpaqueTransportMessage) {
    if (msg.streamId !== streamId) {
      return;
    }

    if (msg.to !== transport.clientId) {
      transport.log?.error('got stream message from unexpected client', {
        clientId: transport.clientId,
        transportMessage: msg,
      });

      return;
    }

    if (isStreamCancel(msg.controlFlags)) {
      cleanClose = false;
      span.addEvent('received cancel');

      const error: ClientError = isSerializedClientErrorResult(msg.payload)
        ? msg.payload.payload
        : {
            code: CANCEL_CODE,
            message: 'stream cancelled with invalid payload',
          };
      pushResponseError(error);

      return;
    }

    if (resReadable.isClosed()) {
      transport.log?.error('received message after response stream is closed', {
        clientId: transport.clientId,
        transportMessage: msg,
      });

      return;
    }

    if (!Value.Check(ControlMessageCloseSchema, msg.payload)) {
      if (msg.payload instanceof Uint8Array) {
        try {
          resReadable._pushValue(
            Ok(
              decodeMessageBytes(method.output, msg.payload) as MessageShape<
                Method['output']
              >,
            ),
          );
        } catch (err) {
          pushResponseError({
            code: INVALID_REQUEST_CODE,
            message: 'failed to decode protobuf response payload',
            extras: { cause: err },
          });

          return;
        }
      } else if (isSerializedClientErrorResult(msg.payload)) {
        resReadable._pushValue(msg.payload);
      } else {
        pushResponseError({
          code: INVALID_REQUEST_CODE,
          message: 'received invalid protobuf response payload',
        });

        return;
      }
    }

    if (isStreamClose(msg.controlFlags)) {
      span.addEvent('received response close');
      closeReadable();
    }
  }

  function onSessionStatus(evt: EventMap['sessionStatus']) {
    if (
      evt.status !== 'closing' ||
      evt.session.to !== serverId ||
      session.id !== evt.session.id
    ) {
      return;
    }

    cleanClose = false;
    pushResponseError({
      code: UNEXPECTED_DISCONNECT_CODE,
      message: `${serverId} unexpectedly disconnected`,
    });
  }

  abortSignal?.addEventListener('abort', onClientCancel);
  transport.addEventListener('message', onMessage);
  transport.addEventListener('sessionStatus', onSessionStatus);

  try {
    sessionScopedSend({
      streamId,
      serviceName: service.typeName,
      procedureName: method.name,
      tracing: getPropagationContext(ctx),
      payload: initialPayload,
      controlFlags: procClosesWithInit
        ? ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit
        : ControlFlags.StreamOpenBit,
    });
  } catch (err) {
    cleanup();
    throw err;
  }

  if (procClosesWithInit) {
    reqWritable.close();
  }

  return { reqWritable, resReadable };
}

function createPreClosedReadable<T>(
  error: ClientError,
): Readable<T, ClientError> {
  const readable = new ReadableImpl<T, ClientError>();
  readable._pushValue(Err(error));
  readable._triggerClose();

  return readable;
}

function createPreClosedWritable<T>(): WritableImpl<T> {
  const writable = new WritableImpl<T>({
    writeCb: () => undefined,
    closeCb: () => undefined,
  });
  writable.close();

  return writable;
}

function createPreClosedClientStreamingCall<Input, Output>(): {
  reqWritable: WritableImpl<Input>;
  finalize: () => Promise<Result<Output, ClientError>>;
} {
  return {
    reqWritable: createPreClosedWritable<Input>(),
    finalize: () =>
      Promise.resolve(
        Err({
          code: UNEXPECTED_DISCONNECT_CODE,
          message: 'transport is closed',
        }),
      ),
  };
}

function createPreClosedBiDiStreamingCall<Input, Output>(): {
  reqWritable: WritableImpl<Input>;
  resReadable: Readable<Output, ClientError>;
} {
  return {
    reqWritable: createPreClosedWritable<Input>(),
    resReadable: createPreClosedReadable<Output>({
      code: UNEXPECTED_DISCONNECT_CODE,
      message: 'transport is closed',
    }),
  };
}

async function getSingleMessage<T>(
  resReadable: Readable<T, ClientError>,
  log?: Logger,
): Promise<Result<T, ClientError>> {
  const ret = await resReadable.collect();
  if (ret.length === 0) {
    return Err({
      code: INVALID_REQUEST_CODE,
      message: 'expected single response from server, got none',
    });
  }

  if (ret.length > 1) {
    log?.error('expected single protobuf response from server, got multiple');
  }

  const first = ret[0];
  if (!first.ok) {
    if (first.payload.code === ReadableBrokenError.code) {
      return Err({
        code: UNEXPECTED_DISCONNECT_CODE,
        message: first.payload.message,
      });
    }

    return Err(first.payload);
  }

  return first;
}
