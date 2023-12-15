import WebSocket from 'isomorphic-ws';
import { WebSocketServer } from 'ws';
import http from 'http';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import { Static } from '@sinclair/typebox';
import { Procedure, ServiceContext } from '../router';
import {
  Connection,
  OpaqueTransportMessage,
  Transport,
  TransportClientId,
  TransportMessage,
  msg,
  reply,
} from '../transport';
import { Pushable, pushable } from 'it-pushable';
import {
  Err,
  Result,
  RiverError,
  RiverUncaughtSchema,
  UNCAUGHT_ERROR,
} from '../router/result';
import { Codec } from '../codec';
import { WebSocketServerTransport } from '../transport/impls/ws/server';
import { PayloadType } from '../router/builder';

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
export async function onServerReady(server: http.Server): Promise<number> {
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
 * Transforms an RPC procedure definition into a normal function call.
 * This should only be used for testing.
 * @template State - The type of the state object.
 * @template I - The type of the input message payload.
 * @template O - The type of the output message payload.
 * @param {State} state - The state object.
 * @param {Procedure<State, 'rpc', I, O, E, null>} proc - The RPC procedure to invoke.
 * @param {Omit<ServiceContext, 'state'>} [extendedContext] - Optional extended context.
 * @returns A function that can be used to invoke the RPC procedure.
 */
export function asClientRpc<
  State extends object | unknown,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
>(
  state: State,
  proc: Procedure<State, 'rpc', I, O, E, null>,
  extendedContext?: Omit<ServiceContext, 'state'>,
) {
  return (
    msg: Static<I>,
  ): Promise<
    Result<Static<O>, Static<E> | Static<typeof RiverUncaughtSchema>>
  > =>
    proc
      .handler({ ...extendedContext, state }, payloadToTransportMessage(msg))
      .then((res) => res.payload)
      .catch((err) => {
        const errorMsg =
          err instanceof Error ? err.message : `[coerced to error] ${err}`;
        return Err({
          code: UNCAUGHT_ERROR,
          message: errorMsg,
        });
      });
}

/**
 * Transforms a stream procedure definition into a pair of input and output streams.
 * Input messages can be pushed into the input stream.
 * This should only be used for testing.
 * @template State - The type of the state object.
 * @template I - The type of the input object.
 * @template O - The type of the output object.
 * @param {State} state - The state object.
 * @param {Procedure<State, 'stream', I, O, E, null>} proc - The procedure to handle the stream.
 * @param {Omit<ServiceContext, 'state'>} [extendedContext] - The extended context object.
 * @returns Pair of input and output streams.
 */
export function asClientStream<
  State extends object | unknown,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
>(
  state: State,
  proc: Procedure<State, 'stream', I, O, E, null>,
  extendedContext?: Omit<ServiceContext, 'state'>,
): [
  Pushable<Static<I>>,
  Pushable<Result<Static<O>, Static<E> | Static<typeof RiverUncaughtSchema>>>,
] {
  const rawInput = pushable<Static<I>>({ objectMode: true });
  const rawOutput = pushable<Result<Static<O>, Static<E>>>({
    objectMode: true,
  });

  const transportInput = pushable<TransportMessage<Static<I>>>({
    objectMode: true,
  });
  const transportOutput = pushable<
    TransportMessage<Result<Static<O>, Static<E>>>
  >({
    objectMode: true,
  });

  // wrapping in transport
  (async () => {
    for await (const rawIn of rawInput) {
      transportInput.push(payloadToTransportMessage(rawIn));
    }
    transportInput.end();
  })();

  // unwrap from transport
  (async () => {
    for await (const transportRes of transportOutput) {
      rawOutput.push(transportRes.payload);
    }
    rawOutput.end();
  })();

  // handle
  (async () => {
    try {
      await proc.handler(
        { ...extendedContext, state },
        transportInput,
        transportOutput,
      );
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : `[coerced to error] ${err}`;
      transportOutput.push(
        reply(
          payloadToTransportMessage({}),
          Err({
            code: UNCAUGHT_ERROR,
            message: errorMsg,
          }),
        ),
      );
    }
    transportOutput.end();
  })();

  return [rawInput, rawOutput];
}

/**
 * Transforms a stream procedure definition into a pair of input and output streams.
 * Input messages can be pushed into the input stream.
 * This should only be used for testing.
 * @template State - The type of the state object.
 * @template I - The type of the input object.
 * @template O - The type of the output object.
 * @param {State} state - The state object.
 * @param {Procedure<State, 'stream', I, O, E, null>} proc - The procedure to handle the stream.
 * @param {Omit<ServiceContext, 'state'>} [extendedContext] - The extended context object.
 * @returns Pair of input and output streams.
 */
export function asClientStreamWithInitialization<
  State extends object | unknown,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
  Init extends PayloadType,
>(
  state: State,
  proc: Procedure<State, 'stream', I, O, E, Init>,
  init: Static<PayloadType>,
  extendedContext?: Omit<ServiceContext, 'state'>,
): [
  Pushable<Static<I>>,
  Pushable<Result<Static<O>, Static<E> | Static<typeof RiverUncaughtSchema>>>,
] {
  const rawInput = pushable<Static<I>>({ objectMode: true });
  const rawOutput = pushable<Result<Static<O>, Static<E>>>({
    objectMode: true,
  });

  const transportInput = pushable<TransportMessage<Static<I>>>({
    objectMode: true,
  });
  const transportOutput = pushable<
    TransportMessage<Result<Static<O>, Static<E>>>
  >({
    objectMode: true,
  });

  // wrapping in transport
  (async () => {
    for await (const rawIn of rawInput) {
      transportInput.push(payloadToTransportMessage(rawIn));
    }
    transportInput.end();
  })();

  // unwrap from transport
  (async () => {
    for await (const transportRes of transportOutput) {
      rawOutput.push(transportRes.payload);
    }
    rawOutput.end();
  })();

  // handle
  (async () => {
    try {
      await proc.handler(
        { ...extendedContext, state },
        payloadToTransportMessage(init),
        transportInput,
        transportOutput,
      );
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : `[coerced to error] ${err}`;
      transportOutput.push(
        reply(
          payloadToTransportMessage({}),
          Err({
            code: UNCAUGHT_ERROR,
            message: errorMsg,
          }),
        ),
      );
    }
    transportOutput.end();
  })();

  return [rawInput, rawOutput];
}

/**
 * Transforms a subscription procedure definition into a procedure that returns an output stream.
 * Input messages can be pushed into the input stream.
 * This should only be used for testing.
 * @template State - The type of the state object.
 * @template I - The type of the input object.
 * @template O - The type of the output object.
 * @param {State} state - The state object.
 * @param {Procedure<State, 'stream', I, O, E, null>} proc - The procedure to handle the stream.
 * @param {Omit<ServiceContext, 'state'>} [extendedContext] - The extended context object.
 * @returns A function that when passed a message, returns the output stream.
 */
export function asClientSubscription<
  State extends object | unknown,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
>(
  state: State,
  proc: Procedure<State, 'subscription', I, O, E, null>,
  extendedContext?: Omit<ServiceContext, 'state'>,
) {
  const rawOutput = pushable<Result<Static<O>, Static<E>>>({
    objectMode: true,
  });
  const transportOutput = pushable<
    TransportMessage<Result<Static<O>, Static<E>>>
  >({
    objectMode: true,
  });

  // unwrap from transport
  (async () => {
    for await (const transportRes of transportOutput) {
      rawOutput.push(transportRes.payload);
    }
    rawOutput.end();
  })();

  return async (
    msg: Static<I>,
  ): Promise<
    Pushable<Result<Static<O>, Static<E> | Static<typeof RiverUncaughtSchema>>>
  > => {
    proc
      .handler(
        { ...extendedContext, state },
        payloadToTransportMessage(msg),
        transportOutput,
      )
      .catch((err) => {
        const errorMsg =
          err instanceof Error ? err.message : `[coerced to error] ${err}`;
        return Err({
          code: UNCAUGHT_ERROR,
          message: errorMsg,
        });
      });

    return rawOutput;
  };
}

/**
 * Transforms an upload procedure definition into a procedure that returns an input stream.
 * Input messages can be pushed into the input stream.
 * This should only be used for testing.
 * @template State - The type of the state object.
 * @template I - The type of the input object.
 * @template O - The type of the output object.
 * @param {State} state - The state object.
 * @param {Procedure<State, 'upload', I, O, E, null>} proc - The procedure to handle the stream.
 * @param {Omit<ServiceContext, 'state'>} [extendedContext] - The extended context object.
 * @returns A function that when passed a message, returns the output stream.
 */
export function asClientUpload<
  State extends object | unknown,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
>(
  state: State,
  proc: Procedure<State, 'upload', I, O, E, null>,
  extendedContext?: Omit<ServiceContext, 'state'>,
): [
  Pushable<Static<I>>,
  Promise<Result<Static<O>, Static<E> | Static<typeof RiverUncaughtSchema>>>,
] {
  const rawInput = pushable<Static<I>>({ objectMode: true });
  const transportInput = pushable<TransportMessage<Static<I>>>({
    objectMode: true,
  });

  // wrapping in transport
  (async () => {
    for await (const rawIn of rawInput) {
      transportInput.push(payloadToTransportMessage(rawIn));
    }
    transportInput.end();
  })();

  return [
    rawInput,
    proc
      .handler({ ...extendedContext, state }, transportInput)
      .then((res) => res.payload)
      .catch((err) => {
        const errorMsg =
          err instanceof Error ? err.message : `[coerced to error] ${err}`;
        return Err({
          code: UNCAUGHT_ERROR,
          message: errorMsg,
        });
      }),
  ];
}

/**
 * Transforms an upload with initialization procedure definition into a procedure that returns an
 * input stream.
 * Input messages can be pushed into the input stream.
 * This should only be used for testing.
 * @template State - The type of the state object.
 * @template Init - The type of the init object.
 * @template I - The type of the input object.
 * @template O - The type of the output object.
 * @param {State} state - The state object.
 * @param {Procedure<State, 'upload', I, O, E, Init>} proc - The procedure to handle the stream.
 * @param {Omit<ServiceContext, 'state'>} [extendedContext] - The extended context object.
 * @returns A function that when passed a message, returns the output stream.
 */
export function asClientUploadWithInitialization<
  State extends object | unknown,
  I extends PayloadType,
  O extends PayloadType,
  E extends RiverError,
  Init extends PayloadType,
>(
  state: State,
  proc: Procedure<State, 'upload', I, O, E, Init>,
  init: Static<Init>,
  extendedContext?: Omit<ServiceContext, 'state'>,
): [
  Pushable<Static<I>>,
  Promise<Result<Static<O>, Static<E> | Static<typeof RiverUncaughtSchema>>>,
] {
  const rawInput = pushable<Static<I>>({ objectMode: true });
  const transportInput = pushable<TransportMessage<Static<I>>>({
    objectMode: true,
  });

  // wrapping in transport
  (async () => {
    for await (const rawIn of rawInput) {
      transportInput.push(payloadToTransportMessage(rawIn));
    }
    transportInput.end();
  })();

  return [
    rawInput,
    proc
      .handler(
        { ...extendedContext, state },
        payloadToTransportMessage(init),
        transportInput,
      )
      .then((res) => res.payload)
      .catch((err) => {
        const errorMsg =
          err instanceof Error ? err.message : `[coerced to error] ${err}`;
        return Err({
          code: UNCAUGHT_ERROR,
          message: errorMsg,
        });
      }),
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
export function iterNext<T>(iter: AsyncIterableIterator<T>) {
  return iter.next().then((res) => res.value);
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
