import NodeWs, { WebSocketServer } from 'ws';
import http from 'node:http';
import { Err, Ok, Result, BaseErrorSchemaType } from '../router/result';
import {
  ProcedureErrorSchemaType,
  ReaderErrorSchema,
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
  Readable,
  ReadableImpl,
  ReadableResult,
  ReadableIterator,
  Writable,
  WritableImpl,
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

const readableIterators = new WeakMap<
  Readable<unknown, Static<BaseErrorSchemaType>>,
  ReadableIterator<unknown, Static<BaseErrorSchemaType>>
>();

/**
 * A safe way to access {@link Readble}'s iterator multiple times in test helpers.
 *
 * If there are other iteration attempts outside of the test helpers
 * (this function, {@link readNextResult}, and {@link isReadableDone})
 * it will throw an error.
 */
export function getReadableIterator<T, E extends Static<BaseErrorSchemaType>>(
  readable: Readable<T, E>,
): ReadableIterator<T, E> {
  let iter = readableIterators.get(readable) as
    | ReadableIterator<T, E>
    | undefined;

  if (!iter) {
    iter = readable[Symbol.asyncIterator]();
    readableIterators.set(readable, iter);
  }

  return iter;
}

/**
 * Retrieves the next value from {@link Readable}, or throws an error if the Readable is done.
 *
 * Calling semantics are similar to {@link getReadableIterator}
 */
export async function readNextResult<T, E extends Static<BaseErrorSchemaType>>(
  readable: Readable<T, E>,
): Promise<ReadableResult<T, E>> {
  const res = await getReadableIterator(readable).next();

  if (res.done) {
    throw new Error('readNext from a done Readable');
  }

  return res.value;
}

/**
 * Checks if the readable is done iterating, it consumes an iteration in the process.
 *
 * Calling semantics are similar to {@link getReadableIterator}
 */
export async function isReadableDone<T, E extends Static<BaseErrorSchemaType>>(
  readable: Readable<T, E>,
) {
  const res = await getReadableIterator(readable).next();

  return res.done;
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
    // TODO might wanna hook these up!
    cancel: () => undefined,
    signal: new AbortController().signal,
  };
}

export function asClientRpc<
  State extends object,
  Init extends PayloadType,
  Res extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(
  state: State,
  proc: Procedure<State, 'rpc', Init, null, Res, Err>,
  extendedContext?: Omit<ServiceContext, 'state'>,
  session: Session<Connection> = dummySession(),
) {
  return async (
    msg: Static<Init>,
  ): Promise<
    Result<Static<Res>, Static<Err> | Static<typeof ReaderErrorSchema>>
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
  Res extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(): {
  readable: Readable<
    Static<Res>,
    Static<Err> | Static<typeof ReaderErrorSchema>
  >;
  writable: Writable<Result<Static<Res>, Static<Err>>>;
} {
  const readable = new ReadableImpl<
    Static<Res>,
    Static<Err> | Static<typeof ReaderErrorSchema>
  >();
  const writable = new WritableImpl<Result<Static<Res>, Static<Err>>>(
    (v) => {
      readable._pushValue(v);
    },
    () => {
      // Make it async to simulate request going over the wire
      // using promises so that we don't get affected by fake timers.
      void Promise.resolve().then(() => {
        readable._triggerClose();
      });
    },
  );

  return { readable, writable };
}

function createRequestPipe<Req extends PayloadType>(): {
  readable: Readable<Static<Req>, Static<typeof ReaderErrorSchema>>;
  writable: Writable<Static<Req>>;
} {
  const readable = new ReadableImpl<
    Static<Req>,
    Static<typeof ReaderErrorSchema>
  >();
  const writable = new WritableImpl<Static<Req>>(
    (v) => {
      readable._pushValue(Ok(v));
    },
    () => {
      // Make it async to simulate request going over the wire
      // using promises so that we don't get affected by fake timers.
      void Promise.resolve().then(() => {
        readable._triggerClose();
      });
    },
  );

  return { readable, writable };
}

export function asClientStream<
  State extends object,
  Init extends PayloadType,
  Req extends PayloadType,
  Res extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(
  state: State,
  proc: Procedure<State, 'stream', Init, Req, Res, Err>,
  reqInit?: Static<Init>,
  extendedContext?: Omit<ServiceContext, 'state'>,
  session: Session<Connection> = dummySession(),
): {
  reqWritable: Writable<Static<Req>>;
  resReadable: Readable<Static<Res>, Static<Err>>;
} {
  const requestPipe = createRequestPipe<Req>();
  const responsePipe = createResponsePipe<Res, Err>();

  void proc
    .handler({
      ctx: dummyCtx(state, session, extendedContext),
      reqInit: reqInit ?? {},
      reqReadable: requestPipe.readable,
      resWritable: responsePipe.writable,
    })
    .catch((err: unknown) => responsePipe.writable.write(catchProcError(err)));

  return {
    reqWritable: requestPipe.writable,
    resReadable: responsePipe.readable,
  };
}

export function asClientSubscription<
  State extends object,
  Init extends PayloadType,
  Res extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(
  state: State,
  proc: Procedure<State, 'subscription', Init, null, Res, Err>,
  extendedContext?: Omit<ServiceContext, 'state'>,
  session: Session<Connection> = dummySession(),
): (msg: Static<Init>) => {
  resReadable: Readable<Static<Res>, Static<Err>>;
} {
  const responsePipe = createResponsePipe<Res, Err>();

  return (msg: Static<Init>) => {
    void proc
      .handler({
        ctx: dummyCtx(state, session, extendedContext),
        reqInit: msg,
        resWritable: responsePipe.writable,
      })
      .catch((err: unknown) =>
        responsePipe.writable.write(catchProcError(err)),
      );

    return { resReadable: responsePipe.readable };
  };
}

export function asClientUpload<
  State extends object,
  Init extends PayloadType,
  Req extends PayloadType,
  Res extends PayloadType,
  Err extends ProcedureErrorSchemaType,
>(
  state: State,
  proc: Procedure<State, 'upload', Init, Req, Res, Err>,
  reqInit?: Static<Init>,
  extendedContext?: Omit<ServiceContext, 'state'>,
  session: Session<Connection> = dummySession(),
): {
  reqWritable: Writable<Static<Req>>;
  finalize: () => Promise<Result<Static<Res>, Static<Err>>>;
} {
  const requestPipe = createRequestPipe<Req>();
  const result = proc
    .handler({
      ctx: dummyCtx(state, session, extendedContext),
      reqInit: reqInit ?? {},
      reqReadable: requestPipe.readable,
    })
    .catch(catchProcError);

  return { reqWritable: requestPipe.writable, finalize: () => result };
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
