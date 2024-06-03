import { ClientTransport } from '../transport/transport';
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
} from '../transport/message';
import { Static } from '@sinclair/typebox';
import { nanoid } from 'nanoid';
import {
  AnyResultSchema,
  Err,
  Result,
  RiverError,
  RiverUncaughtSchema,
  UNEXPECTED_DISCONNECT,
} from './result';
import { EventMap } from '../transport/events';
import { Connection } from '../transport/session';
import { log } from '../logging/log';
import { createProcTelemetryInfo, getPropagationContext } from '../tracing';
import { ClientHandshakeOptions } from './handshake';
import {
  ReadStream,
  ReadStreamImpl,
  WriteStream,
  WriteStreamImpl,
} from './streams';
import { Value } from '@sinclair/typebox/value';
import { PayloadType, ValidProcType } from './procedures';

type RPCFn<
  Router extends AnyService,
  ProcName extends keyof Router['procedures'],
> = (
  init: Static<ProcInit<Router, ProcName>>,
) => Promise<
  Result<
    Static<ProcOutput<Router, ProcName>>,
    Static<ProcErrors<Router, ProcName>>
  >
>;

type UploadFn<
  Router extends AnyService,
  ProcName extends keyof Router['procedures'],
> = (
  init: Static<ProcInit<Router, ProcName>>,
) => [
  WriteStream<Static<ProcInput<Router, ProcName>>>,
  () => Promise<
    Result<
      Static<ProcOutput<Router, ProcName>>,
      Static<ProcErrors<Router, ProcName>>
    >
  >,
];

type StreamFn<
  Router extends AnyService,
  ProcName extends keyof Router['procedures'],
> = (
  init: Static<ProcInit<Router, ProcName>>,
) => [
  WriteStream<Static<ProcInput<Router, ProcName>>>,
  ReadStream<
    Result<
      Static<ProcOutput<Router, ProcName>>,
      Static<ProcErrors<Router, ProcName>>
    >
  >,
];

type SubscriptionFn<
  Router extends AnyService,
  ProcName extends keyof Router['procedures'],
> = (
  init: Static<ProcInit<Router, ProcName>>,
) => ReadStream<
  Result<
    Static<ProcOutput<Router, ProcName>>,
    Static<ProcErrors<Router, ProcName>>
  >
>;

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
        rpc: RPCFn<Router, ProcName>;
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

  const options = { ...defaultClientOptions, ...providedClientOptions };
  if (options.eagerlyConnect) {
    void transport.connect(serverId);
  }

  return _createRecursiveProxy((opts) => {
    const [serviceName, procName, procMethod] = [...opts.path];
    if (!(serviceName && procName && procMethod)) {
      throw new Error(
        'invalid river call, ensure the service and procedure you are calling exists',
      );
    }

    const [init] = opts.args;
    log?.info(`invoked ${procMethod} ${serviceName}.${procName}`, {
      clientId: transport.clientId,
      transportMessage: {
        procedureName: procName,
        serviceName,
      },
    });

    if (options.connectOnInvoke && !transport.connections.has(serverId)) {
      void transport.connect(serverId);
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
    );
  }, []) as Client<ServiceSchemaMap>;
}

type ClientProcReturn<ProcType extends ValidProcType> = ReturnType<
  ProcType extends 'rpc'
    ? RPCFn<AnyService, string>
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
): ClientProcReturn<ValidProcType> {
  const procClosesWithInit = procType === 'rpc' || procType === 'subscription';

  const streamId = nanoid();
  const { span, ctx } = createProcTelemetryInfo(
    procType,
    serviceName,
    procedureName,
    streamId,
  );
  let didSessionDisconnect = false;
  const inputWriter = new WriteStreamImpl<Static<PayloadType>>(
    (rawIn) => {
      transport.send(serverId, {
        streamId,
        payload: rawIn,
        controlFlags: 0,
        tracing: getPropagationContext(ctx),
      });
    },
    () => {
      span.addEvent('inputWriter closed');

      if (!procClosesWithInit && !didSessionDisconnect) {
        //
        // If the session ended, we don't need to be sending any more messages.
        transport.sendCloseControl(serverId, streamId);
      }

      maybeCleanup();
    },
  );

  const outputReader = new ReadStreamImpl<
    Result<Static<PayloadType>, Static<RiverError>>
  >(() => {
    transport.sendRequestCloseControl(serverId, streamId);
  });
  const removeOnCloseListener = outputReader.onClose(() => {
    span.addEvent('outputReader closed');
    maybeCleanup();
  });

  function maybeCleanup() {
    if (!inputWriter.isClosed() || !outputReader.isClosed()) {
      return;
    }

    transport.removeEventListener('message', onMessage);
    transport.removeEventListener('sessionStatus', onSessionStatus);
    removeOnCloseListener();
    span.end();
  }

  function onMessage(msg: OpaqueTransportMessage) {
    if (msg.streamId !== streamId) return;
    if (msg.to !== transport.clientId) return;

    if (outputReader.isClosed()) {
      log?.error('Received message after stream is closed', {
        clientId: transport.clientId,
        transportMessage: msg,
      });

      return;
    }

    if (!Value.Check(ControlMessageCloseSchema, msg.payload)) {
      if (Value.Check(AnyResultSchema, msg.payload)) {
        outputReader.pushValue(msg.payload);
      } else {
        log?.error('Got non-control payload, but was not a valid result', {
          clientId: transport.clientId,
          transportMessage: msg,
          validationErrors: [...Value.Errors(AnyResultSchema, msg.payload)],
        });
      }
    }

    if (Value.Check(RiverUncaughtSchema, msg.payload)) {
      inputWriter.close();
      outputReader.triggerClose();
    }

    if (isStreamClose(msg.controlFlags) && !outputReader.isClosed()) {
      outputReader.triggerClose();
    }

    if (
      isStreamCloseRequest(msg.controlFlags) &&
      !inputWriter.isCloseRequested()
    ) {
      inputWriter.triggerCloseRequest();
    }
  }

  function onSessionStatus(evt: EventMap['sessionStatus']) {
    if (evt.status !== 'disconnect') {
      return;
    }

    if (evt.session.to !== serverId) {
      return;
    }

    didSessionDisconnect = true;
    if (!outputReader.isClosed()) {
      outputReader.pushValue(
        Err({
          code: UNEXPECTED_DISCONNECT,
          message: `${serverId} unexpectedly disconnected`,
        }),
      );
    }

    inputWriter.close();
  }

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
    inputWriter.close();
  }

  if (procType === 'subscription') {
    return outputReader;
  }

  if (procType === 'rpc') {
    return getSingleMessage(outputReader);
  }

  if (procType === 'upload') {
    let didFinalize = false;
    return [
      inputWriter,
      async () => {
        if (didFinalize) {
          throw new Error('upload stream already finalized');
        }

        didFinalize = true;

        if (!inputWriter.isClosed()) {
          inputWriter.close();
        }

        return getSingleMessage(outputReader);
      },
    ];
  }

  // good ol' `stream` procType
  return [inputWriter, outputReader];
}

async function getSingleMessage(
  outputReader: ReadStream<Result<unknown, Static<RiverError>>>,
): Promise<Result<unknown, Static<RiverError>>> {
  const ret = await outputReader.asArray();

  if (ret.length > 1) {
    log?.error('Expected single message from server, got multiple');
  }

  return ret[0];
}
