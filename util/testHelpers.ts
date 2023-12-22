import WebSocket from 'isomorphic-ws';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import {
  Connection,
  OpaqueTransportMessage,
  Transport,
  TransportClientId,
  TransportMessage,
  msg,
} from '../transport';
import { pushable } from 'it-pushable';
import { Codec } from '../codec';
import { WebSocketServerTransport } from '../transport/impls/ws/server';
import {
  PayloadType,
  Procedure,
  Result,
  RiverError,
  RiverUncaughtSchema,
  ServiceContext,
  UNCAUGHT_ERROR,
} from '../router';
import { Static } from '@sinclair/typebox';
import { nanoid } from 'nanoid';
import net from 'node:net';

/**
 * Creates a WebSocket server instance using the provided HTTP server.
 * Only used as helper for testing.
 * @param server - The HTTP server instance to use for the WebSocket server.
 * @returns A Promise that resolves to the created WebSocket server instance.
 */
export async function createWebSocketServer(server: http.Server) {
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

export function onUnixSocketServeReady(
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
export async function createLocalWebSocketClient(port: number) {
  const sock = new WebSocket(`ws://localhost:${port}`);
  sock.binaryType = 'arraybuffer';
  return sock;
}

/**
 * Creates a pair of WebSocket transports for testing purposes.
 * @param port - The port number to use for the client transport. This should be acquired after starting a server via {@link createWebSocketServer}.
 * @param wss - The WebSocketServer instance to use for the server transport.
 * @returns An array containing the client and server {@link WebSocketClientTransport} instances.
 */
export function createWsTransports(
  port: number,
  wss: WebSocketServer,
  codec?: Codec,
): [WebSocketClientTransport, WebSocketServerTransport] {
  const options = codec ? { codec } : undefined;
  return [
    new WebSocketClientTransport(
      () => createLocalWebSocketClient(port),
      'client',
      'SERVER',
      options,
    ),
    new WebSocketServerTransport(wss, 'SERVER', options),
  ];
}

/**
 * Converts a payload object to a transport message with reasonable defaults.
 * This should only be used for testing.
 * @param payload - The payload object to be converted.
 * @param streamId - The optional stream ID.
 * @returns The transport message.
 */
export function payloadToTransportMessage<Payload extends object>(
  payload: Payload,
  streamId?: string,
  from: TransportClientId = 'client',
  to: TransportClientId = 'SERVER',
): TransportMessage<Payload> {
  return msg(from, to, streamId ?? 'stream', payload, 'service', 'procedure');
}

/**
 * Creates a dummy opaque transport message for testing purposes.
 * @returns The created opaque transport message.
 */
export function createDummyTransportMessage(): OpaqueTransportMessage {
  return payloadToTransportMessage({
    msg: 'cool',
    test: Math.random(),
  });
}

/**
 * Retrieves the next value from an async iterable iterator.
 * @param iter The async iterable iterator.
 * @returns A promise that resolves to the next value from the iterator.
 */
export async function iterNext<T>(iter: AsyncIterableIterator<T>) {
  return await iter.next().then((res) => res.value);
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
      if (!filter || filter?.(msg)) {
        cleanup();
        resolve(msg.payload);
      } else if (rejectMismatch) {
        reject(new Error('message didnt match the filter'));
      }
    }

    t.addEventListener('message', onMessage);
  });
}

function catchProcError(err: unknown) {
  const errorMsg =
    err instanceof Error ? err.message : `[coerced to error] ${err}`;
  return {
    ok: false,
    payload: {
      code: UNCAUGHT_ERROR,
      message: errorMsg,
    },
  };
}

export function asClientRpc<
  State extends object | unknown,
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
      .handler({ ...extendedContext, state }, msg)
      .catch(catchProcError);
  };
}

export function asClientStream<
  State extends object | unknown,
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

  (async () => {
    if (init) {
      const _proc = proc as Procedure<State, 'stream', I, O, E, PayloadType>;
      await _proc
        .handler({ ...extendedContext, state }, init, input, output)
        .catch((err) => output.push(catchProcError(err)));
    } else {
      const _proc = proc as Procedure<State, 'stream', I, O, E, null>;
      await _proc
        .handler({ ...extendedContext, state }, input, output)
        .catch((err) => output.push(catchProcError(err)));
    }
  })();

  return [input, output] as const;
}

export function asClientSubscription<
  State extends object | unknown,
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

  return async (msg: Static<I>) => {
    (async () => {
      return await proc
        .handler({ ...extendedContext, state }, msg, output)
        .catch((err) => output.push(catchProcError(err)));
    })();
    return output;
  };
}

export async function asClientUpload<
  State extends object | unknown,
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
      .handler({ ...extendedContext, state }, init, input)
      .catch(catchProcError);
    return [input, result] as const;
  } else {
    const _proc = proc as Procedure<State, 'upload', I, O, E, null>;
    const result = _proc
      .handler({ ...extendedContext, state }, input)
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
