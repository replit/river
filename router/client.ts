import {
  AnyService,
  ProcErrors,
  ProcInit,
  ProcRequest,
  ProcResponse,
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
  isStreamCancel,
  closeStreamMessage,
  cancelMessage,
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
import { Readable, ReadableImpl, Writable, WritableImpl } from './streams';
import { Value } from '@sinclair/typebox/value';
import {
  CANCEL_CODE,
  ReaderErrorSchema,
  PayloadType,
  UNEXPECTED_DISCONNECT_CODE,
  ValidProcType,
} from './procedures';

const ReaderErrResultSchema = ErrResultSchema(ReaderErrorSchema);

interface CallOptions {
  signal?: AbortSignal;
}

type RpcFn<
  Service extends AnyService,
  ProcName extends keyof Service['procedures'],
> = (
  reqInit: ProcInit<Service, ProcName>,
  options?: CallOptions,
) => Promise<
  Result<ProcResponse<Service, ProcName>, ProcErrors<Service, ProcName>>
>;

type UploadFn<
  Service extends AnyService,
  ProcName extends keyof Service['procedures'],
> = (
  reqInit: ProcInit<Service, ProcName>,
  options?: CallOptions,
) => {
  reqWritable: Writable<ProcRequest<Service, ProcName>>;
  finalize: () => Promise<
    Result<ProcResponse<Service, ProcName>, ProcErrors<Service, ProcName>>
  >;
};

type StreamFn<
  Service extends AnyService,
  ProcName extends keyof Service['procedures'],
> = (
  reqInit: ProcInit<Service, ProcName>,
  options?: CallOptions,
) => {
  reqWritable: Writable<ProcRequest<Service, ProcName>>;
  resReadable: Readable<
    ProcResponse<Service, ProcName>,
    ProcErrors<Service, ProcName>
  >;
};

type SubscriptionFn<
  Service extends AnyService,
  ProcName extends keyof Service['procedures'],
> = (
  reqInit: ProcInit<Service, ProcName>,
  options?: CallOptions,
) => {
  resReadable: Readable<
    ProcResponse<Service, ProcName>,
    ProcErrors<Service, ProcName>
  >;
};

/**
 * A helper type to transform an actual service type into a type
 * we can case to in the proxy.
 * @template Service - The type of the Service.
 */
type ServiceClient<Service extends AnyService> = {
  [ProcName in keyof Service['procedures']]: ProcType<
    Service,
    ProcName
  > extends 'rpc'
    ? {
        // If your go-to-definition ended up here, you probably meant to
        // go to the procedure name. For example:
        // riverClient.myService.someprocedure.rpc({})
        //            click here ^^^^^^^^^^^^^
        rpc: RpcFn<Service, ProcName>;
      }
    : ProcType<Service, ProcName> extends 'upload'
    ? {
        // If your go-to-definition ended up here, you probably meant to
        // go to the procedure name. For example:
        // riverClient.myService.someprocedure.upload({})
        //            click here ^^^^^^^^^^^^^
        upload: UploadFn<Service, ProcName>;
      }
    : ProcType<Service, ProcName> extends 'stream'
    ? {
        // If your go-to-definition ended up here, you probably meant to
        // go to the procedure name. For example:
        // riverClient.myService.someprocedure.stream({})
        //            click here ^^^^^^^^^^^^^
        stream: StreamFn<Service, ProcName>;
      }
    : ProcType<Service, ProcName> extends 'subscription'
    ? {
        // If your go-to-definition ended up here, you probably meant to
        // go to the procedure name. For example:
        // riverClient.myService.subscribe.stream({})
        //            click here ^^^^^^^^^^^^^
        subscribe: SubscriptionFn<Service, ProcName>;
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

type AnyProcReturn =
  | ReturnType<RpcFn<AnyService, string>>
  | ReturnType<UploadFn<AnyService, string>>
  | ReturnType<StreamFn<AnyService, string>>
  | ReturnType<SubscriptionFn<AnyService, string>>;

function handleProc(
  procType: ValidProcType,
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  init: Static<PayloadType>,
  serviceName: string,
  procedureName: string,
  abortSignal?: AbortSignal,
): AnyProcReturn {
  const session = transport.getOrCreateSession(serverId);
  const sessionScopedSend = transport.getSessionBoundSendFn(
    serverId,
    session.id,
  );

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
  const reqWritable = new WritableImpl<Static<PayloadType>>({
    writeCb: (rawIn) => {
      sessionScopedSend({
        streamId,
        payload: rawIn,
        controlFlags: 0,
      });
    },
    // close callback
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
    Static<PayloadType>,
    Static<BaseErrorSchemaType>
  >();
  const closeReadable = () => {
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

  function onClientCancel() {
    if (resReadable.isClosed() && reqWritable.isClosed()) {
      return;
    }

    span.addEvent('sending cancel');
    cleanClose = false;

    if (!resReadable.isClosed()) {
      resReadable._pushValue(
        Err({
          code: CANCEL_CODE,
          message: 'cancelled by client',
        }),
      );
      closeReadable();
    }

    reqWritable.close();
    sessionScopedSend(
      cancelMessage(
        streamId,
        Err({
          code: CANCEL_CODE,
          message: 'cancelled by client',
        }),
      ),
    );
  }

  function onMessage(msg: OpaqueTransportMessage) {
    if (msg.streamId !== streamId) return;
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
      let cancelResult: Static<typeof ReaderErrResultSchema>;

      if (Value.Check(ReaderErrResultSchema, msg.payload)) {
        cancelResult = msg.payload;
      } else {
        cancelResult = Err({
          code: CANCEL_CODE,
          message: 'stream cancelled with invalid payload',
        });
        transport.log?.error(
          'got stream cancel without a valid protocol error',
          {
            clientId: transport.clientId,
            transportMessage: msg,
            validationErrors: [
              ...Value.Errors(ReaderErrResultSchema, msg.payload),
            ],
          },
        );
      }

      if (!resReadable.isClosed()) {
        resReadable._pushValue(cancelResult);
        closeReadable();
      }

      reqWritable.close();

      return;
    }

    if (resReadable.isClosed()) {
      span.recordException('received message after response stream is closed');

      transport.log?.error('received message after response stream is closed', {
        clientId: transport.clientId,
        transportMessage: msg,
      });

      return;
    }

    if (!Value.Check(ControlMessageCloseSchema, msg.payload)) {
      if (Value.Check(AnyResultSchema, msg.payload)) {
        resReadable._pushValue(msg.payload);
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
      span.addEvent('received response close');

      if (resReadable.isClosed()) {
        transport.log?.error(
          'received stream close but readable was already closed',
        );
      } else {
        closeReadable();
      }
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
    if (!resReadable.isClosed()) {
      resReadable._pushValue(
        Err({
          code: UNEXPECTED_DISCONNECT_CODE,
          message: `${serverId} unexpectedly disconnected`,
        }),
      );
      closeReadable();
    }

    reqWritable.close();
  }

  abortSignal?.addEventListener('abort', onClientCancel);
  transport.addEventListener('message', onMessage);
  transport.addEventListener('sessionStatus', onSessionStatus);

  sessionScopedSend({
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
    reqWritable.close();
  }

  if (procType === 'subscription') {
    return {
      resReadable: resReadable,
    };
  }

  if (procType === 'rpc') {
    return getSingleMessage(resReadable, transport.log);
  }

  if (procType === 'upload') {
    let didFinalize = false;
    return {
      reqWritable: reqWritable,
      finalize: () => {
        if (didFinalize) {
          throw new Error('upload stream already finalized');
        }

        didFinalize = true;

        if (!reqWritable.isClosed()) {
          reqWritable.close();
        }

        return getSingleMessage(resReadable, transport.log);
      },
    };
  }

  // good ol' `stream` procType
  return {
    resReadable: resReadable,
    reqWritable: reqWritable,
  };
}

/**
 * Waits for a message in the response AND the server to close.
 * Logs an error if we receive  multiple messages.
 * Used in RPC and Upload.
 */
async function getSingleMessage(
  resReadable: Readable<unknown, Static<BaseErrorSchemaType>>,
  log?: Logger,
): Promise<Result<unknown, Static<BaseErrorSchemaType>>> {
  const ret = await resReadable.collect();

  if (ret.length > 1) {
    log?.error('Expected single message from server, got multiple');
  }

  return ret[0];
}
