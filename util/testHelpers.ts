import NodeWs, { WebSocketServer } from 'ws';
import http from 'node:http';
import { Err, Ok, Result, BaseErrorSchemaType } from '../router/result';
import {
  ProcedureErrorSchemaType,
  RequestReaderErrorSchema,
  ResponseReaderErrorSchema,
  UNCAUGHT_ERROR_CODE,
  PayloadType,
  Procedure,
} from '../router/procedures';
import { Static } from '@sinclair/typebox';
import {
  OpaqueTransportMessage,
  PartialTransportMessage,
  currentProtocolVersion,
} from '../transport/message';
import { coerceErrorString } from './stringify';
import { Transport } from '../transport/transport';
import {
  ReadStream,
  WriteStream,
  ReadStreamImpl,
  WriteStreamImpl,
} from '../router/streams';
import { ServiceContext, ProcedureHandlerContext } from '../router/context';
import { WsLike } from '../transport/impls/ws/wslike';
import {
  defaultClientTransportOptions,
  defaultTransportOptions,
} from '../transport/options';
import { Connection } from '../transport/connection';
import { SessionState } from '../transport/sessionStateMachine/common';
import {
  Session,
  SessionStateGraph,
} from '../transport/sessionStateMachine/transitions';

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

export const testingSessionOptions = defaultTransportOptions;
export const testingClientSessionOptions = defaultClientTransportOptions;

export function dummySession() {
  return SessionStateGraph.entrypoints.NoConnection(
    'client',
    'server',
    {
      onSessionGracePeriodElapsed: () => {
        /* noop */
      },
    },
    testingSessionOptions,
    currentProtocolVersion,
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
    sessionId: session.id,
    from: session.from,
    metadata: {},
    abortController: new AbortController(),
    clientAbortSignal: new AbortController().signal,
    onRequestFinished: () => undefined,
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
    Result<
      Static<Output>,
      Static<Err> | Static<typeof ResponseReaderErrorSchema>
    >
  > => {
    return proc
      .handler({
        ctx: dummyCtx(state, session, extendedContext),
        reqInit: msg,
      })
      .catch(catchProcError);
  };
}

function createResponsePipe<
  Output extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(): {
  reader: ReadStream<
    Static<Output>,
    Static<Err> | Static<typeof ResponseReaderErrorSchema>
  >;
  writer: WriteStream<Result<Static<Output>, Static<Err>>>;
} {
  const reader = new ReadStreamImpl<
    Static<Output>,
    Static<Err> | Static<typeof ResponseReaderErrorSchema>
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
  );
  writer.onClose(() => {
    // Make it async to simulate request going over the wire
    // using promises so that we don't get affected by fake timers.
    void Promise.resolve().then(() => {
      reader.triggerClose();
    });
  });

  return { reader, writer };
}

function createRequestPipe<Input extends PayloadType>(): {
  reader: ReadStream<Static<Input>, Static<typeof RequestReaderErrorSchema>>;
  writer: WriteStream<Static<Input>>;
} {
  const reader = new ReadStreamImpl<
    Static<Input>,
    Static<typeof RequestReaderErrorSchema>
  >(() => {
    // Make it async to simulate request going over the wire
    // using promises so that we don't get affected by fake timers.
    void Promise.resolve().then(() => {
      writer.triggerCloseRequest();
    });
  });
  const writer = new WriteStreamImpl<Static<Input>>((v) => {
    reader.pushValue(Ok(v));
  });
  writer.onClose(() => {
    // Make it async to simulate request going over the wire
    // using promises so that we don't get affected by fake timers.
    void Promise.resolve().then(() => {
      reader.triggerClose();
    });
  });

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
  reqInit?: Static<Init>,
  extendedContext?: Omit<ServiceContext, 'state'>,
  session: Session<Connection> = dummySession(),
): {
  reqWriter: WriteStream<Static<Input>>;
  resReader: ReadStream<Static<Output>, Static<Err>>;
} {
  const requestPipe = createRequestPipe<Input>();
  const responsePipe = createResponsePipe<Output, Err>();

  void proc
    .handler({
      ctx: dummyCtx(state, session, extendedContext),
      reqInit: reqInit ?? {},
      reqReader: requestPipe.reader,
      resWriter: responsePipe.writer,
    })
    .catch((err: unknown) => responsePipe.writer.write(catchProcError(err)));

  return {
    reqWriter: requestPipe.writer,
    resReader: responsePipe.reader,
  };
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
): (msg: Static<Init>) => {
  resReader: ReadStream<Static<Output>, Static<Err>>;
} {
  const responsePipe = createResponsePipe<Output, Err>();

  return (msg: Static<Init>) => {
    void proc
      .handler({
        ctx: dummyCtx(state, session, extendedContext),
        reqInit: msg,
        resWriter: responsePipe.writer,
      })
      .catch((err: unknown) => responsePipe.writer.write(catchProcError(err)));

    return { resReader: responsePipe.reader };
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
  reqInit?: Static<Init>,
  extendedContext?: Omit<ServiceContext, 'state'>,
  session: Session<Connection> = dummySession(),
): [
  WriteStream<Static<Input>>,
  () => Promise<Result<Static<Output>, Static<Err>>>,
] {
  const requestPipe = createRequestPipe<Input>();
  const result = proc
    .handler({
      ctx: dummyCtx(state, session, extendedContext),
      reqInit: reqInit ?? {},
      reqReader: requestPipe.reader,
    })
    .catch(catchProcError);

  return [requestPipe.writer, () => result];
}

export function getTransportConnections<ConnType extends Connection>(
  transport: Transport<ConnType>,
): Array<ConnType> {
  const connections = [];
  for (const session of transport.sessions.values()) {
    if (session.state === SessionState.Connected) {
      connections.push(session.conn);
    }
  }

  return connections;
}

export function numberOfConnections<ConnType extends Connection>(
  transport: Transport<ConnType>,
): number {
  return getTransportConnections(transport).length;
}

export function closeAllConnections<ConnType extends Connection>(
  transport: Transport<ConnType>,
) {
  for (const conn of getTransportConnections(transport)) {
    conn.close();
  }
}
