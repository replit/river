import { Transport } from '../transport/transport';
import {
  AnyService,
  ProcErrors,
  ProcHasInit,
  ProcInit,
  ProcInput,
  ProcOutput,
  ProcType,
} from './builder';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import { Server } from './server';
import {
  OpaqueTransportMessage,
  ControlFlags,
  msg,
  TransportClientId,
  isStreamClose,
  closeStream,
} from '../transport/message';
import { Static } from '@sinclair/typebox';
import { nanoid } from 'nanoid';
import { Err, Result, UNEXPECTED_DISCONNECT } from './result';
import { EventMap } from '../transport/events';
import { ServiceDefs } from './defs';
import { Connection } from '../transport';

// helper to make next, yield, and return all the same type
export type AsyncIter<T> = AsyncGenerator<T, T, unknown>;

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
export type ServerClient<Srv extends Server<ServiceDefs>> = {
  [SvcName in keyof Srv['services']]: ServiceClient<Srv['services'][SvcName]>;
};

interface ProxyCallbackOptions {
  path: string[];
  args: unknown[];
}

type ProxyCallback = (opts: ProxyCallbackOptions) => unknown;
const noop = () => {};

function _createRecursiveProxy(
  callback: ProxyCallback,
  path: string[],
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
export const createClient = <Srv extends Server<ServiceDefs>>(
  transport: Transport<Connection>,
  serverId: TransportClientId = 'SERVER',
) =>
  _createRecursiveProxy(async (opts) => {
    const [serviceName, procName, procType] = [...opts.path];
    if (!(serviceName && procName && procType)) {
      throw new Error(
        'invalid river call, ensure the service and procedure you are calling exists',
      );
    }

    const [input] = opts.args;
    if (procType === 'rpc') {
      return handleRpc(
        transport,
        serverId,
        input as object,
        serviceName,
        procName,
      );
    } else if (procType === 'stream') {
      return handleStream(
        transport,
        serverId,
        input as object | undefined,
        serviceName,
        procName,
      );
    } else if (procType === 'subscribe') {
      return handleSubscribe(
        transport,
        serverId,
        input as object,
        serviceName,
        procName,
      );
    } else if (procType === 'upload') {
      return handleUpload(
        transport,
        serverId,
        input as object | undefined,
        serviceName,
        procName,
      );
    } else {
      throw new Error(`invalid river call, unknown procedure type ${procType}`);
    }
  }, []) as ServerClient<Srv>;

export function onSessionDisconnect(from: TransportClientId, cb: () => void) {
  return (evt: EventMap['sessionStatus']) => {
    if (evt.status === 'disconnect' && evt.session.connectedTo === from) {
      cb();
    }
  };
}

function handleRpc(
  transport: Transport<Connection>,
  serverId: TransportClientId,
  input: object,
  serviceName: string,
  procName: string,
) {
  const streamId = nanoid();
  const m = msg(
    transport.clientId,
    serverId,
    streamId,
    input,
    serviceName,
    procName,
  );

  // rpc is a stream open + close
  m.controlFlags |= ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit;
  transport.send(m);

  const responsePromise = new Promise((resolve) => {
    // on disconnect, set a timer to return an error
    // on (re)connect, clear the timer
    const onSessionStatus = onSessionDisconnect(serverId, () => {
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
      if (msg.streamId !== streamId) {
        return;
      }

      if (msg.to !== transport.clientId) {
        return;
      }

      if (msg.streamId === streamId) {
        // cleanup and resolve as soon as we get a message
        cleanup();
        resolve(msg.payload);
      }
    }

    transport.addEventListener('message', onMessage);
    transport.addEventListener('sessionStatus', onSessionStatus);
  });
  return responsePromise;
}

function handleStream(
  transport: Transport<Connection>,
  serverId: TransportClientId,
  init: object | undefined,
  serviceName: string,
  procName: string,
) {
  const streamId = nanoid();
  const inputStream = pushable({ objectMode: true });
  const outputStream = pushable({ objectMode: true });
  let firstMessage = true;

  if (init) {
    const m = msg(
      transport.clientId,
      serverId,
      streamId,
      init,
      serviceName,
      procName,
    );

    // first message needs the open bit.
    m.controlFlags = ControlFlags.StreamOpenBit;
    transport.send(m);
    firstMessage = false;
  }

  // input -> transport
  // this gets cleaned up on inputStream.end() which is called by closeHandler
  (async () => {
    for await (const rawIn of inputStream) {
      const m = msg(transport.clientId, serverId, streamId, rawIn as object);

      if (firstMessage) {
        m.serviceName = serviceName;
        m.procedureName = procName;
        m.controlFlags |= ControlFlags.StreamOpenBit;
        firstMessage = false;
      }

      transport.send(m);
    }

    // after ending input stream, send a close message to the server
    transport.send(closeStream(transport.clientId, serverId, streamId));
  })();

  // transport -> output
  function onMessage(msg: OpaqueTransportMessage) {
    if (msg.streamId !== streamId) {
      return;
    }

    if (msg.to !== transport.clientId) {
      return;
    }

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
  }

  const closeHandler = () => {
    cleanup();
    transport.send(closeStream(transport.clientId, serverId, streamId));
  };

  // close stream after disconnect + grace period elapses
  const onSessionStatus = onSessionDisconnect(serverId, () => {
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
  return [inputStream, outputStream, closeHandler];
}

function handleSubscribe(
  transport: Transport<Connection>,
  serverId: TransportClientId,
  input: object,
  serviceName: string,
  procName: string,
) {
  const streamId = nanoid();
  const m = msg(
    transport.clientId,
    serverId,
    streamId,
    input,
    serviceName,
    procName,
  );
  m.controlFlags |= ControlFlags.StreamOpenBit;
  transport.send(m);

  // transport -> output
  const outputStream = pushable({ objectMode: true });
  function onMessage(msg: OpaqueTransportMessage) {
    if (msg.streamId !== streamId) {
      return;
    }

    if (msg.to !== transport.clientId) {
      return;
    }

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
  }

  const closeHandler = () => {
    cleanup();
    transport.send(closeStream(transport.clientId, serverId, streamId));
  };

  // close stream after disconnect + grace period elapses
  const onSessionStatus = onSessionDisconnect(serverId, () => {
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
  transport: Transport<Connection>,
  serverId: TransportClientId,
  input: object | undefined,
  serviceName: string,
  procName: string,
) {
  const streamId = nanoid();
  const inputStream = pushable({ objectMode: true });
  let firstMessage = true;

  if (input) {
    const m = msg(
      transport.clientId,
      serverId,
      streamId,
      input as object,
      serviceName,
      procName,
    );

    // first message needs the open bit.
    m.controlFlags = ControlFlags.StreamOpenBit;
    transport.send(m);
    firstMessage = false;
  }

  // input -> transport
  // this gets cleaned up on inputStream.end(), which the caller should call.
  (async () => {
    for await (const rawIn of inputStream) {
      const m = msg(transport.clientId, serverId, streamId, rawIn as object);

      if (firstMessage) {
        m.controlFlags |= ControlFlags.StreamOpenBit;
        m.serviceName = serviceName;
        m.procedureName = procName;
        firstMessage = false;
      }

      transport.send(m);
    }

    transport.send(closeStream(transport.clientId, serverId, streamId));
  })();

  const responsePromise = new Promise((resolve) => {
    // on disconnect, set a timer to return an error
    // on (re)connect, clear the timer
    const onSessionStatus = onSessionDisconnect(serverId, () => {
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
    }

    function onMessage(msg: OpaqueTransportMessage) {
      if (msg.to !== transport.clientId) {
        return;
      }

      if (msg.streamId === streamId) {
        // cleanup and resolve as soon as we get a message
        cleanup();
        resolve(msg.payload);
      }
    }

    transport.addEventListener('message', onMessage);
    transport.addEventListener('sessionStatus', onSessionStatus);
  });
  return [inputStream, responsePromise];
}
