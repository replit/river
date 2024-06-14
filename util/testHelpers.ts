import NodeWs, { WebSocketServer } from 'ws';
import http from 'node:http';
import {
  Err,
  Ok,
  PayloadType,
  Procedure,
  Result,
  ProcedureErrorSchemaType,
  InputReaderErrorSchema,
  OutputReaderErrorSchema,
  ServiceContext,
  ProcedureHandlerContext,
  UNCAUGHT_ERROR_CODE,
} from '../router';
import { Static } from '@sinclair/typebox';
import { nanoid } from 'nanoid';
import net from 'node:net';
import {
  OpaqueTransportMessage,
  PartialTransportMessage,
} from '../transport/message';
import { coerceErrorString } from './stringify';
import { Connection, Session, SessionOptions } from '../transport/session';
import { Transport } from '../transport/transport';
import {
  ReadStream,
  ReadStreamImpl,
  WriteStream,
  WriteStreamImpl,
} from '../router/streams';
import { WsLike } from '../transport/impls/ws/wslike';
import { defaultTransportOptions } from '../transport/options';
import { BaseErrorSchemaType } from '../router/result';

/**
 * Creates a WebSocket client that connects to a local server at the specified port.
 * This should only be used for testing.
 * @param port - The port number to connect to.
 * @returns A Promise that resolves to a WebSocket instance.
 */
export function createLocalWebSocketClient(port: number): WsLike {
  const sock = new NodeWs(`ws://localhost:${port}`);
  sock.binaryType = 'arraybuffer';

  return sock;
}

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

export function getIteratorFromStream<T, E extends Static<BaseErrorSchemaType>>(
  readStream: ReadStream<T, E>,
) {
  return readStream[Symbol.asyncIterator]();
}

/**
 * Retrieves the next value from an async iterable iterator.
 * @param iter The async iterable iterator.
 * @returns A promise that resolves to the next value from the iterator.
 */
export async function iterNext<T>(iter: {
  next(): Promise<
    | {
        done: false;
        value: T;
      }
    | {
        done: true;
        value: undefined;
      }
  >;
}) {
  return await iter.next().then((res) => res.value as T);
}

export function payloadToTransportMessage<Payload>(
  payload: Payload,
): PartialTransportMessage<Payload> {
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
  return Err({ code: UNCAUGHT_ERROR_CODE, message: errorMsg });
}

export const testingSessionOptions: SessionOptions = defaultTransportOptions;

export function dummySession() {
  return new Session<Connection>(
    undefined,
    'client',
    'server',
    testingSessionOptions,
  );
}

function dummyCtx<State>(
  state: State,
  session: Session<Connection>,
  extendedContext?: Omit<ServiceContext, 'state'>,
): ProcedureHandlerContext<State> {
  return {
    ...extendedContext,
    state,
    session,
    metadata: {},
    abortController: new AbortController(),
    clientAbortSignal: new AbortController().signal,
    addCleanup: () => undefined,
  };
}

export function asClientRpc<
  State extends object,
  Init extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(
  state: State,
  proc: Procedure<State, 'rpc', Init, null, Output, Err>,
  extendedContext?: Omit<ServiceContext, 'state'>,
  session: Session<Connection> = dummySession(),
) {
  return async (
    msg: Static<Init>,
  ): Promise<
    Result<Static<Output>, Static<Err> | Static<typeof OutputReaderErrorSchema>>
  > => {
    return proc
      .handler(dummyCtx(state, session, extendedContext), msg)
      .catch(catchProcError);
  };
}

function createOutputPipe<
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(): {
  reader: ReadStream<
    Static<Output>,
    Static<Err> | Static<typeof OutputReaderErrorSchema>
  >;
  writer: WriteStream<Result<Static<Output>, Static<Err>>>;
} {
  const reader = new ReadStreamImpl<
    Static<Output>,
    Static<Err> | Static<typeof OutputReaderErrorSchema>
  >(() => {
    // Make it async to simulate request going over the wire
    // using promises so that we don't get affected by fake timers.
    void Promise.resolve().then(() => {
      writer.triggerCloseRequest();
    });
  });
  const writer = new WriteStreamImpl<Result<Static<Output>, Static<Err>>>(
    (v) => {
      reader.pushValue(v);
    },
    () => {
      // Make it async to simulate request going over the wire
      // using promises so that we don't get affected by fake timers.
      void Promise.resolve().then(() => {
        reader.triggerClose();
      });
    },
  );

  return { reader, writer };
}

function createInputPipe<Input extends PayloadType>(): {
  reader: ReadStream<Static<Input>, Static<typeof InputReaderErrorSchema>>;
  writer: WriteStream<Static<Input>>;
} {
  const reader = new ReadStreamImpl<
    Static<Input>,
    Static<typeof InputReaderErrorSchema>
  >(() => {
    // Make it async to simulate request going over the wire
    // using promises so that we don't get affected by fake timers.
    void Promise.resolve().then(() => {
      writer.triggerCloseRequest();
    });
  });
  const writer = new WriteStreamImpl<Static<Input>>(
    (v) => {
      reader.pushValue(Ok(v));
    },
    () => {
      // Make it async to simulate request going over the wire
      // using promises so that we don't get affected by fake timers.
      void Promise.resolve().then(() => {
        reader.triggerClose();
      });
    },
  );

  return { reader, writer };
}

export function asClientStream<
  State extends object,
  Init extends PayloadType,
  Input extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(
  state: State,
  proc: Procedure<State, 'stream', Init, Input, Output, Err>,
  init?: Static<Init>,
  extendedContext?: Omit<ServiceContext, 'state'>,
  session: Session<Connection> = dummySession(),
): [WriteStream<Static<Input>>, ReadStream<Static<Output>, Static<Err>>] {
  const inputPipe = createInputPipe<Input>();
  const outputPipe = createOutputPipe<Output, Err>();

  void proc
    .handler(
      dummyCtx(state, session, extendedContext),
      init ?? {},
      inputPipe.reader,
      outputPipe.writer,
    )
    .catch((err: unknown) => outputPipe.writer.write(catchProcError(err)));

  return [inputPipe.writer, outputPipe.reader];
}

export function asClientSubscription<
  State extends object,
  Init extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(
  state: State,
  proc: Procedure<State, 'subscription', Init, null, Output, Err>,
  extendedContext?: Omit<ServiceContext, 'state'>,
  session: Session<Connection> = dummySession(),
): (msg: Static<Init>) => ReadStream<Static<Output>, Static<Err>> {
  const outputPipe = createOutputPipe<Output, Err>();

  return (msg: Static<Init>) => {
    void proc
      .handler(
        dummyCtx(state, session, extendedContext),
        msg,
        outputPipe.writer,
      )
      .catch((err: unknown) => outputPipe.writer.write(catchProcError(err)));

    return outputPipe.reader;
  };
}

export function asClientUpload<
  State extends object,
  Init extends PayloadType,
  Input extends PayloadType,
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(
  state: State,
  proc: Procedure<State, 'upload', Init, Input, Output, Err>,
  init?: Static<Init>,
  extendedContext?: Omit<ServiceContext, 'state'>,
  session: Session<Connection> = dummySession(),
): [
  WriteStream<Static<Input>>,
  () => Promise<Result<Static<Output>, Static<Err>>>,
] {
  const inputPipe = createInputPipe<Input>();
  const result = proc
    .handler(
      dummyCtx(state, session, extendedContext),
      init ?? {},
      inputPipe.reader,
    )
    .catch(catchProcError);

  return [inputPipe.writer, () => result];
}

export const getUnixSocketPath = () => {
  // https://nodejs.org/api/net.html#identifying-paths-for-ipc-connections
  return process.platform === 'win32'
    ? `\\\\?\\pipe\\${nanoid()}`
    : `/tmp/${nanoid()}.sock`;
};
