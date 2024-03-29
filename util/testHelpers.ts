import WebSocket from 'isomorphic-ws';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import {
  Connection,
  OpaqueTransportMessage,
  Session,
  Transport,
} from '../transport';
import { pushable } from 'it-pushable';
import {
  PayloadType,
  Procedure,
  Result,
  RiverError,
  RiverUncaughtSchema,
  ServiceContext,
  ServiceContextWithTransportInfo,
  UNCAUGHT_ERROR,
} from '../router';
import { Static } from '@sinclair/typebox';
import { nanoid } from 'nanoid';
import net from 'node:net';
import { PartialTransportMessage } from '../transport/message';
import { coerceErrorString } from './stringify';
import { defaultSessionOptions } from '../transport/session';

/**
 * Creates a WebSocket server instance using the provided HTTP server.
 * Only used as helper for testing.
 * @param server - The HTTP server instance to use for the WebSocket server.
 * @returns A Promise that resolves to the created WebSocket server instance.
 */
export function createWebSocketServer(server: http.Server) {
  return new WebSocketServer({ server });
}

/**
 * Starts listening on the given server and returns the automatically allocated port number.
 * This should only be used for testing.
 * @param server - The http server to listen on.
 * @returns A promise that resolves with the allocated port number.
 * @throws An error if a port cannot be allocated.
 */
export function onWsServerReady(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(() => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve(addr.port);
      } else {
        reject(new Error("couldn't find a port to allocate"));
      }
    });
  });
}

export function onUdsServeReady(
  server: net.Server,
  path: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });
}

/**
 * Creates a WebSocket client that connects to a local server at the specified port.
 * This should only be used for testing.
 * @param port - The port number to connect to.
 * @returns A Promise that resolves to a WebSocket instance.
 */
export function createLocalWebSocketClient(port: number) {
  const sock = new WebSocket(`ws://localhost:${port}`);
  sock.binaryType = 'arraybuffer';
  return sock;
}

/**
 * Retrieves the next value from an async iterable iterator.
 * @param iter The async iterable iterator.
 * @returns A promise that resolves to the next value from the iterator.
 */
export async function iterNext<T>(iter: AsyncIterableIterator<T>) {
  return await iter.next().then((res) => res.value as T);
}

export function payloadToTransportMessage<
  Payload extends Record<string, unknown>,
>(payload: Payload): PartialTransportMessage<Payload> {
  return {
    streamId: 'stream',
    controlFlags: 0,
    payload,
  };
}

export function createDummyTransportMessage() {
  return payloadToTransportMessage({
    msg: 'cool',
    test: Math.random(),
  });
}

/**
 * Waits for a message on the transport.
 * @param {Transport} t - The transport to listen to.
 * @param filter - An optional filter function to apply to the received messages.
 * @returns A promise that resolves with the payload of the first message that passes the filter.
 */
export async function waitForMessage(
  t: Transport<Connection>,
  filter?: (msg: OpaqueTransportMessage) => boolean,
  rejectMismatch?: boolean,
) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      t.removeEventListener('message', onMessage);
    }

    function onMessage(msg: OpaqueTransportMessage) {
      if (!filter || filter(msg)) {
        cleanup();
        resolve(msg.payload);
      } else if (rejectMismatch) {
        cleanup();
        reject(new Error('message didnt match the filter'));
      }
    }

    t.addEventListener('message', onMessage);
  });
}

function catchProcError(err: unknown) {
  const errorMsg = coerceErrorString(err);
  return {
    ok: false,
    payload: {
      code: UNCAUGHT_ERROR,
      message: errorMsg,
    },
  };
}

function dummyCtx<State>(
  state: State,
  extendedContext?: Omit<ServiceContext, 'state'>,
): ServiceContextWithTransportInfo<State> {
  const session = new Session<Connection>(
    'client',
    'SERVER',
    undefined,
    defaultSessionOptions,
  );

  return {
    ...extendedContext,
    state,
    to: 'SERVER',
    from: 'client',
    streamId: nanoid(),
    session,
  };
}

export function asClientRpc<
  State extends object,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
  Init extends PayloadType | null = null,
>(
  state: State,
  proc: Procedure<State, 'rpc', I, O, E, Init>,
  extendedContext?: Omit<ServiceContext, 'state'>,
) {
  return async (
    msg: Static<I>,
  ): Promise<
    Result<Static<O>, Static<E> | Static<typeof RiverUncaughtSchema>>
  > => {
    return await proc
      .handler(dummyCtx(state, extendedContext), msg)
      .catch(catchProcError);
  };
}

export function asClientStream<
  State extends object,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
  Init extends PayloadType | null = null,
>(
  state: State,
  proc: Procedure<State, 'stream', I, O, E, Init>,
  init?: Init extends PayloadType ? Static<Init> : null,
  extendedContext?: Omit<ServiceContext, 'state'>,
) {
  const input = pushable<Static<I>>({ objectMode: true });
  const output = pushable<Result<Static<O>, Static<E>>>({
    objectMode: true,
  });

  void (async () => {
    if (init) {
      const _proc = proc as Procedure<State, 'stream', I, O, E, PayloadType>;
      await _proc
        .handler(dummyCtx(state, extendedContext), init, input, output)
        .catch((err) => output.push(catchProcError(err)));
    } else {
      const _proc = proc as Procedure<State, 'stream', I, O, E>;
      await _proc
        .handler(dummyCtx(state, extendedContext), input, output)
        .catch((err) => output.push(catchProcError(err)));
    }
  })();

  return [input, output] as const;
}

export function asClientSubscription<
  State extends object,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
>(
  state: State,
  proc: Procedure<State, 'subscription', I, O, E>,
  extendedContext?: Omit<ServiceContext, 'state'>,
) {
  const output = pushable<Result<Static<O>, Static<E>>>({
    objectMode: true,
  });

  return (msg: Static<I>) => {
    void (async () => {
      return await proc
        .handler(dummyCtx(state, extendedContext), msg, output)
        .catch((err) => output.push(catchProcError(err)));
    })();
    return output;
  };
}

export function asClientUpload<
  State extends object,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
  Init extends PayloadType | null = null,
>(
  state: State,
  proc: Procedure<State, 'upload', I, O, E, Init>,
  init?: Init extends PayloadType ? Static<Init> : null,
  extendedContext?: Omit<ServiceContext, 'state'>,
) {
  const input = pushable<Static<I>>({ objectMode: true });
  if (init) {
    const _proc = proc as Procedure<State, 'upload', I, O, E, PayloadType>;
    const result = _proc
      .handler(dummyCtx(state, extendedContext), init, input)
      .catch(catchProcError);
    return [input, result] as const;
  } else {
    const _proc = proc as Procedure<State, 'upload', I, O, E>;
    const result = _proc
      .handler(dummyCtx(state, extendedContext), input)
      .catch(catchProcError);
    return [input, result] as const;
  }
}

export const getUnixSocketPath = () => {
  // https://nodejs.org/api/net.html#identifying-paths-for-ipc-connections
  return process.platform === 'win32'
    ? `\\\\?\\pipe\\${nanoid()}`
    : `/tmp/${nanoid()}.sock`;
};
