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
import {
  OpaqueTransportMessage,
  ControlFlags,
  TransportClientId,
  isStreamClose,
  PartialTransportMessage,
} from '../transport/message';
import { Static } from '@sinclair/typebox';
import { nanoid } from 'nanoid';
import { Err, Result, UNEXPECTED_DISCONNECT } from './result';
import { EventMap } from '../transport/events';
import { Connection } from '../transport';
import { log } from '../logging/log';

// helper to make next, yield, and return all the same type
export type AsyncIter<T> = AsyncGenerator<T, T>;

/**
 * A helper type to transform an actual service type into a type
 * we can case to in the proxy.
 *
 * If you end up here in "click to definition", you probably want
 * to click to definition on the procedure not the procedure type,
 * which will take you to the schema definition that contains the
 * input, output, and error types.
 * e.g. client.someService.someProcedure.rpc
 *                         ^^^^^^^^^^^^^ Click here
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
              (input: Static<ProcInput<Router, ProcName>>) => void, // input
              () => Promise<
                Result<
                  Static<ProcOutput<Router, ProcName>>,
                  Static<ProcErrors<Router, ProcName>>
                >
              >, // finalize
            ]
          >;
        }
      : {
          upload: () => Promise<
            [
              (input: Static<ProcInput<Router, ProcName>>) => void, // input
              () => Promise<
                Result<
                  Static<ProcOutput<Router, ProcName>>,
                  Static<ProcErrors<Router, ProcName>>
                >
              >, // finalize
            ]
          >;
        }
    : ProcType<Router, ProcName> extends 'stream'
    ? ProcHasInit<Router, ProcName> extends true
      ? {
          stream: (init: Static<ProcInit<Router, ProcName>>) => Promise<
            [
              (input: Static<ProcInput<Router, ProcName>>) => void, // input
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
              (input: Static<ProcInput<Router, ProcName>>) => void, // input
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
 * @returns The client for the server.
 */
export const createClient = <ServiceSchemaMap extends AnyServiceSchemaMap>(
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  providedClientOptions: Partial<ClientOptions> = {},
): Client<ServiceSchemaMap> => {
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
};

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
  transport.send(serverId, {
    streamId,
    serviceName,
    procedureName,
    payload: input,
    controlFlags: ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
  });

  return new Promise((resolve) => {
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
    }

    function onMessage(msg: OpaqueTransportMessage) {
      if (msg.streamId !== streamId) return;
      if (msg.to !== transport.clientId) return;

      cleanup();
      resolve(msg.payload);
    }

    transport.addEventListener('message', onMessage);
    transport.addEventListener('sessionStatus', onSessionStatus);
  });
}

function handleStream(
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  init: unknown,
  serviceName: string,
  procedureName: string,
) {
  const streamId = nanoid();
  const outputStream = pushable({ objectMode: true });
  let firstMessage = true;
  let didClose = false;
  let didClientClose = false;

  function sendInput(payload: unknown) {
    if (didClientClose) {
      throw new Error('cannot send stream input messages after closing');
    }

    if (didClose) {
      // TODO: should sendInput let you know if the stream is closed?
      return;
    }

    const m: PartialTransportMessage = {
      streamId,
      payload,
      controlFlags: 0,
    };

    if (firstMessage) {
      m.serviceName = serviceName;
      m.procedureName = procedureName;
      m.controlFlags |= ControlFlags.StreamOpenBit;
      firstMessage = false;
    }

    transport.send(serverId, m);
  }

  if (init) {
    sendInput(init);
  }

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
    outputStream.end();
    transport.removeEventListener('message', onMessage);
    transport.removeEventListener('sessionStatus', onSessionStatus);
    didClose = true;
  }

  function closeHandler() {
    didClientClose = true;

    if (didClose) return;

    cleanup();
    transport.sendCloseStream(serverId, streamId);
  }

  const onSessionStatus = createSessionDisconnectHandler(serverId, () => {
    outputStream.push(
      Err({
        code: UNEXPECTED_DISCONNECT,
        message: `${serverId} unexpectedly disconnected`,
      }),
    );

    cleanup();
  });

  transport.addEventListener('message', onMessage);
  transport.addEventListener('sessionStatus', onSessionStatus);

  return [sendInput, outputStream, closeHandler];
}

function handleSubscribe(
  transport: ClientTransport<Connection>,
  serverId: TransportClientId,
  input: unknown,
  serviceName: string,
  procedureName: string,
) {
  const streamId = nanoid();
  let didClose = false;
  transport.send(serverId, {
    streamId,
    serviceName,
    procedureName,
    payload: input,
    controlFlags: ControlFlags.StreamOpenBit,
  });

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
    didClose = true;
  }

  const closeHandler = () => {
    if (didClose) return;

    cleanup();
    transport.sendCloseStream(serverId, streamId);
  };

  const onSessionStatus = createSessionDisconnectHandler(serverId, () => {
    outputStream.push(
      Err({
        code: UNEXPECTED_DISCONNECT,
        message: `${serverId} unexpectedly disconnected`,
      }),
    );
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
  let firstMessage = true;
  let didSessionDisconnect = false;
  let didFinalize = false;

  function sendInput(payload: unknown) {
    if (didFinalize) {
      throw new Error('cannot send more upload messages after finalization');
    }

    if (didSessionDisconnect) {
      // TODO: should sendInput let you know if the stream is closed?
      return;
    }

    const m: PartialTransportMessage = {
      streamId,
      payload,
      controlFlags: 0,
    };

    if (firstMessage) {
      m.serviceName = serviceName;
      m.procedureName = procedureName;
      m.controlFlags |= ControlFlags.StreamOpenBit;
      firstMessage = false;
    }

    transport.send(serverId, m);
  }

  if (init) {
    sendInput(init);
  }

  const outerOnSessionStatus = createSessionDisconnectHandler(serverId, () => {
    didSessionDisconnect = true;
  });

  function onMessageInvariant(msg: OpaqueTransportMessage) {
    if (msg.streamId !== streamId) return;
    if (msg.to !== transport.clientId) return;

    // TODO handle server-side initiated closes

    log?.error('received response for upload before client-side finalization');
  }

  transport.addEventListener('message', onMessageInvariant);

  function finalize() {
    if (didFinalize) {
      throw new Error('cannot finalize multiple times');
    }

    transport.removeEventListener('message', onMessageInvariant);
    transport.removeEventListener('sessionStatus', outerOnSessionStatus);

    didFinalize = true;

    outerCleanup();

    if (didSessionDisconnect) {
      return Promise.resolve(
        Err({
          code: UNEXPECTED_DISCONNECT,
          message: `${serverId} unexpectedly disconnected`,
        }),
      );
    }

    return new Promise((resolve) => {
      const onSessionStatus = createSessionDisconnectHandler(serverId, () => {
        cleanup();
        resolve(
          Err({
            code: UNEXPECTED_DISCONNECT,
            message: `${serverId} unexpectedly disconnected`,
          }),
        );
      });

      function onMessage(msg: OpaqueTransportMessage) {
        if (msg.streamId !== streamId) return;
        if (msg.to !== transport.clientId) return;

        cleanup();
        resolve(msg.payload);
      }

      function cleanup() {
        transport.removeEventListener('message', onMessage);
        transport.removeEventListener('sessionStatus', onSessionStatus);
      }

      transport.addEventListener('sessionStatus', onSessionStatus);
      transport.addEventListener('message', onMessage);
      transport.sendCloseStream(serverId, streamId);
    });
  }

  return [sendInput, finalize];
}
