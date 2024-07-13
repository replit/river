import {
  AnyService,
  ProcErrors,
  ProcInit,
  ProcInput,
  ProcOutput,
  ProcType,
  AnyServiceSchemaMap,
  InstantiatedServiceSchemaMap,
} from './services';
import {
  OpaqueTransportMessage,
  ControlFlags,
  TransportClientId,
  isStreamClose,
  ControlMessageCloseSchema,
  isStreamCloseRequest,
  isStreamAbort,
  closeStreamMessage,
  requestCloseStreamMessage,
  abortMessage,
} from '../transport/message';
import { Static } from '@sinclair/typebox';
import {
  BaseErrorSchemaType,
  Err,
  Result,
  AnyResultSchema,
  ErrResultSchema,
} from './result';
import { EventMap } from '../transport/events';
import { Connection } from '../transport/connection';
import { Logger } from '../logging';
import { createProcTelemetryInfo, getPropagationContext } from '../tracing';
import { ClientHandshakeOptions } from './handshake';
import { ClientTransport } from '../transport/client';
import { generateId } from '../transport/id';
import {
  ReadStream,
  ReadStreamImpl,
  WriteStream,
  WriteStreamImpl,
} from './streams';
import { Value } from '@sinclair/typebox/value';
import {
  ABORT_CODE,
  ResponseReaderErrorSchema,
  PayloadType,
  UNEXPECTED_DISCONNECT_CODE,
  ValidProcType,
} from './procedures';

const OutputErrResultSchema = ErrResultSchema(ResponseReaderErrorSchema);

interface CallOptions {
  signal?: AbortSignal;
}

type RpcFn<
  Router extends AnyService,
  ProcName extends keyof Router['procedures'],
> = (
  init: ProcInit<Router, ProcName>,
  options?: CallOptions,
) => Promise<
  Result<ProcOutput<Router, ProcName>, ProcErrors<Router, ProcName>>
>;

type UploadFn<
  Router extends AnyService,
  ProcName extends keyof Router['procedures'],
> = (
  init: ProcInit<Router, ProcName>,
  options?: CallOptions,
) => {
  requestWriter: WriteStream<ProcInput<Router, ProcName>>;
  finalize: () => Promise<
    Result<ProcOutput<Router, ProcName>, ProcErrors<Router, ProcName>>
  >;
};

type StreamFn<
  Router extends AnyService,
  ProcName extends keyof Router['procedures'],
> = (
  init: ProcInit<Router, ProcName>,
  options?: CallOptions,
) => {
  requestWriter: WriteStream<ProcInput<Router, ProcName>>;
  responseReader: ReadStream<
    ProcOutput<Router, ProcName>,
    ProcErrors<Router, ProcName>
  >;
};

type SubscriptionFn<
  Router extends AnyService,
  ProcName extends keyof Router['procedures'],
> = (
  init: ProcInit<Router, ProcName>,
  options?: CallOptions,
) => {
  responseReader: ReadStream<
    ProcOutput<Router, ProcName>,
    ProcErrors<Router, ProcName>
  >;
};

/**
 * A helper type to transform an actual service type into a type
 * we can case to in the proxy.
 * @template Router - The type of the Router.
 */
type ServiceClient<Router extends AnyService> = {
  [ProcName in keyof Router['procedures']]: ProcType<
    Router,
    ProcName
  > extends 'rpc'
    ? {
        // If your go-to-definition ended up here, you probably meant to
        // go to the procedure name. For example:
        // riverClient.myService.someprocedure.rpc({})
        //            click here ^^^^^^^^^^^^^
        rpc: RpcFn<Router, ProcName>;
      }
    : ProcType<Router, ProcName> extends 'upload'
    ? {
        // If your go-to-definition ended up here, you probably meant to
        // go to the procedure name. For example:
        // riverClient.myService.someprocedure.upload({})
        //            click here ^^^^^^^^^^^^^
        upload: UploadFn<Router, ProcName>;
      }
    : ProcType<Router, ProcName> extends 'stream'
    ? {
        // If your go-to-definition ended up here, you probably meant to
        // go to the procedure name. For example:
        // riverClient.myService.someprocedure.stream({})
        //            click here ^^^^^^^^^^^^^
        stream: StreamFn<Router, ProcName>;
      }
    : ProcType<Router, ProcName> extends 'subscription'
    ? {
        // If your go-to-definition ended up here, you probably meant to
        // go to the procedure name. For example:
        // riverClient.myService.subscribe.stream({})
        //            click here ^^^^^^^^^^^^^
        subscribe: SubscriptionFn<Router, ProcName>;
      }
    : never;
};

/**
 * Defines a type that represents a client for a server with a set of services.
 * @template Srv - The type of the server.
 */
export type Client<
  Services extends AnyServiceSchemaMap,
  IS extends
    InstantiatedServiceSchemaMap<Services> = InstantiatedServiceSchemaMap<Services>,
> = {
  [SvcName in keyof IS]: ServiceClient<IS[SvcName]>;
};

interface ProxyCallbackOptions {
  path: Array<string>;
  args: Array<unknown>;
}

type ProxyCallback = (opts: ProxyCallbackOptions) => unknown;
/* eslint-disable-next-line @typescript-eslint/no-empty-function */
const noop = () => {};

function _createRecursiveProxy(
  callback: ProxyCallback,
  path: Array<string>,
): unknown {
  const proxy: unknown = new Proxy(noop, {
    // property access, recurse and add field to path
    get(_obj, key) {
      if (typeof key !== 'string') return undefined;
      return _createRecursiveProxy(callback, [...path, key]);
    },
    // hit the end, let's invoke the handler
    apply(_target, _this, args) {
      return callback({
        path,
        args,
      });
    },
  });

  return proxy;
}

export interface ClientOptions {
  connectOnInvoke: boolean;
  eagerlyConnect: boolean;
}

const defaultClientOptions: ClientOptions = {
  connectOnInvoke: true,
  eagerlyConnect: true,
};

/**
 * Creates a client for a given server using the provided transport.
 * Note that the client only needs the type of the server, not the actual
 * server definition itself.
 *
 * This relies on a proxy to dynamically create the client, so the client
 * will be typed as if it were the actual server with the appropriate services
 * and procedures.
 *
 * @template Srv - The type of the server.
 * @param {Transport} transport - The transport to use for communication.
 * @param {TransportClientId} serverId - The ID of the server to connect to.
 * @param {Partial<ClientOptions>} providedClientOptions - The options for the client.
 * @returns The client for the server.
 */
export function createClient<ServiceSchemaMap extends AnyServiceSchemaMap>(
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  providedClientOptions: Partial<
    ClientOptions & {
      handshakeOptions: ClientHandshakeOptions;
    }
  > = {},
): Client<ServiceSchemaMap> {
  if (providedClientOptions.handshakeOptions) {
    transport.extendHandshake(providedClientOptions.handshakeOptions);
  }

  const clientOptions = { ...defaultClientOptions, ...providedClientOptions };
  if (clientOptions.eagerlyConnect) {
    transport.connect(serverId);
  }

  return _createRecursiveProxy((opts) => {
    const [serviceName, procName, procMethod] = [...opts.path];
    if (!(serviceName && procName && procMethod)) {
      throw new Error(
        'invalid river call, ensure the service and procedure you are calling exists',
      );
    }

    const [init, callOptions] = opts.args;

    if (clientOptions.connectOnInvoke && !transport.sessions.has(serverId)) {
      transport.connect(serverId);
    }

    if (
      procMethod !== 'rpc' &&
      procMethod !== 'subscribe' &&
      procMethod !== 'stream' &&
      procMethod !== 'upload'
    ) {
      throw new Error(
        `invalid river call, unknown procedure type ${procMethod}`,
      );
    }

    return handleProc(
      procMethod === 'subscribe' ? 'subscription' : procMethod,
      transport,
      serverId,
      init,
      serviceName,
      procName,
      callOptions ? (callOptions as CallOptions).signal : undefined,
    );
  }, []) as Client<ServiceSchemaMap>;
}

type ClientProcReturn<ProcType extends ValidProcType> = ReturnType<
  ProcType extends 'rpc'
    ? RpcFn<AnyService, string>
    : ProcType extends 'upload'
    ? UploadFn<AnyService, string>
    : ProcType extends 'stream'
    ? StreamFn<AnyService, string>
    : ProcType extends 'subscription'
    ? SubscriptionFn<AnyService, string>
    : never
>;

function handleProc(
  procType: ValidProcType,
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  init: Static<PayloadType>,
  serviceName: string,
  procedureName: string,
  abortSignal?: AbortSignal,
): ClientProcReturn<ValidProcType> {
  const procClosesWithInit = procType === 'rpc' || procType === 'subscription';

  const streamId = generateId();
  const { span, ctx } = createProcTelemetryInfo(
    transport,
    procType,
    serviceName,
    procedureName,
    streamId,
  );
  let cleanClose = true;
  const requestWriter = new WriteStreamImpl<Static<PayloadType>>((rawIn) => {
    transport.send(serverId, {
      streamId,
      payload: rawIn,
      controlFlags: 0,
      tracing: getPropagationContext(ctx),
    });
  });
  requestWriter.onClose(() => {
    span.addEvent('requestWriter closed');

    if (!procClosesWithInit && cleanClose) {
      transport.send(serverId, closeStreamMessage(streamId));
    }

    if (responseReader.isClosed()) {
      cleanup();
    }
  });

  const responseReader = new ReadStreamImpl<
    Static<PayloadType>,
    Static<BaseErrorSchemaType>
  >(() => {
    transport.send(serverId, requestCloseStreamMessage(streamId));
  });
  responseReader.onClose(() => {
    span.addEvent('responseReader closed');

    if (requestWriter.isClosed()) {
      cleanup();
    }
  });

  function cleanup() {
    transport.removeEventListener('message', onMessage);
    transport.removeEventListener('sessionStatus', onSessionStatus);
    abortSignal?.removeEventListener('abort', onClientAbort);
    span.end();
  }

  function onClientAbort() {
    if (responseReader.isClosed() && requestWriter.isClosed()) {
      return;
    }

    span.addEvent('sending abort');

    cleanClose = false;

    if (!responseReader.isClosed()) {
      responseReader.pushValue(
        Err({
          code: ABORT_CODE,
          message: 'Aborted by client',
        }),
      );
      responseReader.triggerClose();
    }

    requestWriter.close();
    transport.send(
      serverId,
      abortMessage(
        streamId,
        Err({
          code: ABORT_CODE,
          message: 'Aborted by client',
        }),
      ),
    );
  }

  function onMessage(msg: OpaqueTransportMessage) {
    if (msg.streamId !== streamId) return;
    if (msg.to !== transport.clientId) {
      transport.log?.error('Got stream message from unexpected client', {
        clientId: transport.clientId,
        transportMessage: msg,
      });

      return;
    }

    if (isStreamCloseRequest(msg.controlFlags)) {
      requestWriter.triggerCloseRequest();
    }

    if (isStreamAbort(msg.controlFlags)) {
      cleanClose = false;

      span.addEvent('received abort');
      let abortResult: Static<typeof OutputErrResultSchema>;

      if (Value.Check(OutputErrResultSchema, msg.payload)) {
        abortResult = msg.payload;
      } else {
        abortResult = Err({
          code: ABORT_CODE,
          message: 'Stream aborted with invalid payload',
        });
        transport.log?.error(
          'Got stream abort without a valid protocol error',
          {
            clientId: transport.clientId,
            transportMessage: msg,
            validationErrors: [
              ...Value.Errors(OutputErrResultSchema, msg.payload),
            ],
          },
        );
      }

      if (!responseReader.isClosed()) {
        responseReader.pushValue(abortResult);
        responseReader.triggerClose();
      }

      requestWriter.close();

      return;
    }

    if (responseReader.isClosed()) {
      span.recordException('Received message after output stream is closed');

      transport.log?.error('Received message after output stream is closed', {
        clientId: transport.clientId,
        transportMessage: msg,
      });

      return;
    }

    if (!Value.Check(ControlMessageCloseSchema, msg.payload)) {
      if (Value.Check(AnyResultSchema, msg.payload)) {
        responseReader.pushValue(msg.payload);
      } else {
        transport.log?.error(
          'Got non-control payload, but was not a valid result',
          {
            clientId: transport.clientId,
            transportMessage: msg,
            validationErrors: [...Value.Errors(AnyResultSchema, msg.payload)],
          },
        );
      }
    }

    if (isStreamClose(msg.controlFlags)) {
      span.addEvent('received output close');

      responseReader.triggerClose();
    }
  }

  function onSessionStatus(evt: EventMap['sessionStatus']) {
    if (evt.status !== 'disconnect') {
      return;
    }

    if (evt.session.to !== serverId) {
      return;
    }

    cleanClose = false;
    if (!responseReader.isClosed()) {
      responseReader.pushValue(
        Err({
          code: UNEXPECTED_DISCONNECT_CODE,
          message: `${serverId} unexpectedly disconnected`,
        }),
      );
    }
    requestWriter.close();
    responseReader.triggerClose();
  }

  abortSignal?.addEventListener('abort', onClientAbort);
  transport.addEventListener('message', onMessage);
  transport.addEventListener('sessionStatus', onSessionStatus);

  transport.send(serverId, {
    streamId,
    serviceName,
    procedureName,
    tracing: getPropagationContext(ctx),
    payload: init,
    controlFlags: procClosesWithInit
      ? ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit
      : ControlFlags.StreamOpenBit,
  });

  if (procClosesWithInit) {
    requestWriter.close();
  }

  if (procType === 'subscription') {
    return { responseReader };
  }

  if (procType === 'rpc') {
    return getSingleMessage(responseReader, transport.log);
  }

  if (procType === 'upload') {
    let didFinalize = false;
    return {
      requestWriter,
      async finalize() {
        if (didFinalize) {
          throw new Error('upload stream already finalized');
        }

        didFinalize = true;

        if (!requestWriter.isClosed()) {
          requestWriter.close();
        }

        return getSingleMessage(responseReader, transport.log);
      },
    };
  }

  // good ol' `stream` procType
  return { requestWriter, responseReader };
}

async function getSingleMessage(
  responseReader: ReadStream<unknown, Static<BaseErrorSchemaType>>,
  log?: Logger,
): Promise<Result<unknown, Static<BaseErrorSchemaType>>> {
  const ret = await responseReader.asArray();

  if (ret.length > 1) {
    log?.error('Expected single message from server, got multiple');
  }

  return ret[0];
}
