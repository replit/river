import { ClientTransport } from '../transport/transport';
import {
  AnyService,
  ProcErrors,
  ProcHasInit,
  ProcInit,
  ProcInput,
  ProcOutput,
  ProcType,
  AnyServiceSchemaMap,
  InstantiatedServiceSchemaMap,
} from './services';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import {
  OpaqueTransportMessage,
  ControlFlags,
  TransportClientId,
  isStreamClose,
  PartialTransportMessage,
  ClientHandshakeOptions,
} from '../transport/message';
import { Static, TSchema } from '@sinclair/typebox';
import { nanoid } from 'nanoid';
import { Err, Result, UNEXPECTED_DISCONNECT } from './result';
import { EventMap } from '../transport/events';
import { Connection } from '../transport/session';
import { log } from '../logging/log';
import { createProcTelemetryInfo, getPropagationContext } from '../tracing';

// helper to make next, yield, and return all the same type
export type AsyncIter<T> = AsyncGenerator<T, T>;

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
        rpc: (
          input: Static<ProcInput<Router, ProcName>>,
        ) => Promise<
          Result<
            Static<ProcOutput<Router, ProcName>>,
            Static<ProcErrors<Router, ProcName>>
          >
        >;
      }
    : ProcType<Router, ProcName> extends 'upload'
    ? ProcHasInit<Router, ProcName> extends true
      ? {
          upload: (init: Static<ProcInit<Router, ProcName>>) => Promise<
            [
              Pushable<Static<ProcInput<Router, ProcName>>>, // input
              Promise<
                Result<
                  Static<ProcOutput<Router, ProcName>>,
                  Static<ProcErrors<Router, ProcName>>
                >
              >, // output
            ]
          >;
        }
      : {
          upload: () => Promise<
            [
              Pushable<Static<ProcInput<Router, ProcName>>>, // input
              Promise<
                Result<
                  Static<ProcOutput<Router, ProcName>>,
                  Static<ProcErrors<Router, ProcName>>
                >
              >, // output
            ]
          >;
        }
    : ProcType<Router, ProcName> extends 'stream'
    ? ProcHasInit<Router, ProcName> extends true
      ? {
          stream: (init: Static<ProcInit<Router, ProcName>>) => Promise<
            [
              Pushable<Static<ProcInput<Router, ProcName>>>, // input
              AsyncIter<
                Result<
                  Static<ProcOutput<Router, ProcName>>,
                  Static<ProcErrors<Router, ProcName>>
                >
              >, // output
              () => void, // close handle
            ]
          >;
        }
      : {
          stream: () => Promise<
            [
              Pushable<Static<ProcInput<Router, ProcName>>>, // input
              AsyncIter<
                Result<
                  Static<ProcOutput<Router, ProcName>>,
                  Static<ProcErrors<Router, ProcName>>
                >
              >, // output
              () => void, // close handle
            ]
          >;
        }
    : ProcType<Router, ProcName> extends 'subscription'
    ? {
        subscribe: (input: Static<ProcInput<Router, ProcName>>) => Promise<
          [
            AsyncIter<
              Result<
                Static<ProcOutput<Router, ProcName>>,
                Static<ProcErrors<Router, ProcName>>
              >
            >, // output
            () => void, // close handle
          ]
        >;
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
export function createClient<
  ServiceSchemaMap extends AnyServiceSchemaMap,
  MetadataSchema extends TSchema = TSchema,
>(
  transport: ClientTransport<Connection, MetadataSchema>,
  serverId: TransportClientId,
  providedClientOptions: Partial<
    ClientOptions & { handshakeOptions: ClientHandshakeOptions<MetadataSchema> }
  > = {},
): Client<ServiceSchemaMap> {
  if (providedClientOptions.handshakeOptions) {
    transport.extendHandshake(providedClientOptions.handshakeOptions);
  }

  const options = { ...defaultClientOptions, ...providedClientOptions };
  if (options.eagerlyConnect) {
    void transport.connect(serverId);
  }

  return _createRecursiveProxy(async (opts) => {
    const [serviceName, procName, procType] = [...opts.path];
    if (!(serviceName && procName && procType)) {
      throw new Error(
        'invalid river call, ensure the service and procedure you are calling exists',
      );
    }

    const [input] = opts.args;
    log?.info(`invoked ${procType} ${serviceName}.${procName}`, {
      clientId: transport.clientId,
      partialTransportMessage: {
        procedureName: procName,
        serviceName,
        payload: input,
      },
    });

    if (options.connectOnInvoke && !transport.connections.has(serverId)) {
      void transport.connect(serverId);
    }

    if (procType === 'rpc') {
      return handleRpc(transport, serverId, input, serviceName, procName);
    } else if (procType === 'stream') {
      return handleStream(transport, serverId, input, serviceName, procName);
    } else if (procType === 'subscribe') {
      return handleSubscribe(transport, serverId, input, serviceName, procName);
    } else if (procType === 'upload') {
      return handleUpload(transport, serverId, input, serviceName, procName);
    } else {
      throw new Error(`invalid river call, unknown procedure type ${procType}`);
    }
  }, []) as Client<ServiceSchemaMap>;
}

function createSessionDisconnectHandler(
  from: TransportClientId,
  cb: () => void,
) {
  return (evt: EventMap['sessionStatus']) => {
    if (evt.status === 'disconnect' && evt.session.to === from) {
      cb();
    }
  };
}

function handleRpc(
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  input: unknown,
  serviceName: string,
  procedureName: string,
) {
  const streamId = nanoid();
  const { span, ctx } = createProcTelemetryInfo(
    'rpc',
    serviceName,
    procedureName,
    streamId,
  );
  transport.send(serverId, {
    streamId,
    serviceName,
    procedureName,
    payload: input,
    tracing: getPropagationContext(ctx),
    controlFlags: ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
  });

  const responsePromise = new Promise((resolve) => {
    // on disconnect, set a timer to return an error
    // on (re)connect, clear the timer
    const onSessionStatus = createSessionDisconnectHandler(serverId, () => {
      cleanup();
      resolve(
        Err({
          code: UNEXPECTED_DISCONNECT,
          message: `${serverId} unexpectedly disconnected`,
        }),
      );
    });

    function cleanup() {
      transport.removeEventListener('message', onMessage);
      transport.removeEventListener('sessionStatus', onSessionStatus);
      span.end();
    }

    function onMessage(msg: OpaqueTransportMessage) {
      if (msg.streamId !== streamId) return;
      if (msg.to !== transport.clientId) return;

      // cleanup and resolve as soon as we get a message
      cleanup();
      resolve(msg.payload);
    }

    transport.addEventListener('message', onMessage);
    transport.addEventListener('sessionStatus', onSessionStatus);
  });
  return responsePromise;
}

function handleStream(
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  init: unknown,
  serviceName: string,
  procedureName: string,
) {
  const streamId = nanoid();
  const { span, ctx } = createProcTelemetryInfo(
    'stream',
    serviceName,
    procedureName,
    streamId,
  );
  const inputStream = pushable({ objectMode: true });
  const outputStream = pushable({ objectMode: true });
  let firstMessage = true;
  let healthyClose = true;

  if (init) {
    transport.send(serverId, {
      streamId,
      serviceName,
      procedureName,
      payload: init,
      tracing: getPropagationContext(ctx),
      controlFlags: ControlFlags.StreamOpenBit,
    });

    firstMessage = false;
  }

  // input -> transport
  // this gets cleaned up on inputStream.end() which is called by closeHandler
  const pipeInputToTransport = async () => {
    for await (const rawIn of inputStream) {
      const m: PartialTransportMessage = {
        streamId,
        payload: rawIn,
        controlFlags: 0,
      };

      if (firstMessage) {
        m.serviceName = serviceName;
        m.procedureName = procedureName;
        m.tracing = getPropagationContext(ctx);
        m.controlFlags |= ControlFlags.StreamOpenBit;
        firstMessage = false;
      }

      transport.send(serverId, m);
    }

    // after ending input stream, send a close message to the server
    if (!healthyClose) return;
    transport.sendCloseStream(serverId, streamId);
  };

  void pipeInputToTransport();

  // transport -> output
  function onMessage(msg: OpaqueTransportMessage) {
    if (msg.streamId !== streamId) return;
    if (msg.to !== transport.clientId) return;

    if (isStreamClose(msg.controlFlags)) {
      cleanup();
    } else {
      outputStream.push(msg.payload);
    }
  }

  function cleanup() {
    inputStream.end();
    outputStream.end();
    transport.removeEventListener('message', onMessage);
    transport.removeEventListener('sessionStatus', onSessionStatus);
    span.end();
  }

  // close stream after disconnect + grace period elapses
  const onSessionStatus = createSessionDisconnectHandler(serverId, () => {
    outputStream.push(
      Err({
        code: UNEXPECTED_DISCONNECT,
        message: `${serverId} unexpectedly disconnected`,
      }),
    );
    healthyClose = false;
    cleanup();
  });

  transport.addEventListener('message', onMessage);
  transport.addEventListener('sessionStatus', onSessionStatus);
  return [inputStream, outputStream, cleanup];
}

function handleSubscribe(
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  input: unknown,
  serviceName: string,
  procedureName: string,
) {
  const streamId = nanoid();
  const { span, ctx } = createProcTelemetryInfo(
    'subscription',
    serviceName,
    procedureName,
    streamId,
  );

  transport.send(serverId, {
    streamId,
    serviceName,
    procedureName,
    payload: input,
    tracing: getPropagationContext(ctx),
    controlFlags: ControlFlags.StreamOpenBit,
  });

  let healthyClose = true;

  // transport -> output
  const outputStream = pushable({ objectMode: true });
  function onMessage(msg: OpaqueTransportMessage) {
    if (msg.streamId !== streamId) return;
    if (msg.to !== transport.clientId) return;

    if (isStreamClose(msg.controlFlags)) {
      cleanup();
    } else {
      outputStream.push(msg.payload);
    }
  }

  function cleanup() {
    outputStream.end();
    transport.removeEventListener('message', onMessage);
    transport.removeEventListener('sessionStatus', onSessionStatus);
    span.end();
  }

  const closeHandler = () => {
    cleanup();
    if (!healthyClose) return;
    transport.sendCloseStream(serverId, streamId);
  };

  // close stream after disconnect + grace period elapses
  const onSessionStatus = createSessionDisconnectHandler(serverId, () => {
    outputStream.push(
      Err({
        code: UNEXPECTED_DISCONNECT,
        message: `${serverId} unexpectedly disconnected`,
      }),
    );
    healthyClose = false;
    cleanup();
  });

  transport.addEventListener('message', onMessage);
  transport.addEventListener('sessionStatus', onSessionStatus);
  return [outputStream, closeHandler];
}

function handleUpload(
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  init: unknown,
  serviceName: string,
  procedureName: string,
) {
  const streamId = nanoid();
  const { span, ctx } = createProcTelemetryInfo(
    'upload',
    serviceName,
    procedureName,
    streamId,
  );
  const inputStream = pushable({ objectMode: true });
  let firstMessage = true;
  let healthyClose = true;

  if (init) {
    transport.send(serverId, {
      streamId,
      serviceName,
      procedureName,
      payload: init,
      tracing: getPropagationContext(ctx),
      controlFlags: ControlFlags.StreamOpenBit,
    });

    firstMessage = false;
  }

  // input -> transport
  // this gets cleaned up on inputStream.end(), which the caller should call.
  const pipeInputToTransport = async () => {
    for await (const rawIn of inputStream) {
      const m: PartialTransportMessage = {
        streamId,
        payload: rawIn,
        controlFlags: 0,
      };

      if (firstMessage) {
        m.serviceName = serviceName;
        m.procedureName = procedureName;
        m.tracing = getPropagationContext(ctx);
        m.controlFlags |= ControlFlags.StreamOpenBit;
        firstMessage = false;
      }

      transport.send(serverId, m);
    }

    // after ending input stream, send a close message to the server
    if (!healthyClose) return;
    transport.sendCloseStream(serverId, streamId);
  };

  void pipeInputToTransport();

  const responsePromise = new Promise((resolve) => {
    // on disconnect, set a timer to return an error
    // on (re)connect, clear the timer
    const onSessionStatus = createSessionDisconnectHandler(serverId, () => {
      healthyClose = false;
      cleanup();
      resolve(
        Err({
          code: UNEXPECTED_DISCONNECT,
          message: `${serverId} unexpectedly disconnected`,
        }),
      );
    });

    function cleanup() {
      inputStream.end();
      transport.removeEventListener('message', onMessage);
      transport.removeEventListener('sessionStatus', onSessionStatus);
      span.end();
    }

    function onMessage(msg: OpaqueTransportMessage) {
      if (msg.streamId !== streamId) return;
      if (msg.to !== transport.clientId) return;

      // cleanup and resolve as soon as we get a message
      cleanup();
      resolve(msg.payload);
    }

    transport.addEventListener('message', onMessage);
    transport.addEventListener('sessionStatus', onSessionStatus);
  });
  return [inputStream, responsePromise];
}
