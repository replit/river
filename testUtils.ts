import WebSocket from 'isomorphic-ws';
import { WebSocketServer } from 'ws';
import http from 'http';
import { WebSocketTransport } from './transport/impls/ws';
import { Static, TObject } from '@sinclair/typebox';
import { Procedure, ServiceContext } from './router';
import { OpaqueTransportMessage, TransportMessage, msg } from './transport';
import { Pushable, pushable } from 'it-pushable';

export async function createWebSocketServer(server: http.Server) {
  return new WebSocketServer({ server });
}

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

export async function createLocalWebSocketClient(port: number) {
  return new WebSocket(`ws://localhost:${port}`);
}

export function createWsTransports(
  port: number,
  wss: WebSocketServer,
): [WebSocketTransport, WebSocketTransport] {
  return [
    new WebSocketTransport(async () => {
      return createLocalWebSocketClient(port);
    }, 'client'),
    new WebSocketTransport(async () => {
      return new Promise<WebSocket>((resolve) => {
        wss.on('connection', async function onConnect(serverSock) {
          wss.removeListener('connection', onConnect);
          resolve(serverSock);
        });
      });
    }, 'SERVER'),
  ];
}

export function asClientRpc<
  State extends object | unknown,
  I extends TObject,
  O extends TObject,
>(
  state: State,
  proc: Procedure<State, 'rpc', I, O>,
  extendedContext?: Omit<ServiceContext, 'state'>,
) {
  return (msg: Static<I>) =>
    proc
      .handler({ ...extendedContext, state }, payloadToTransportMessage(msg))
      .then((res) => res.payload);
}

export function asClientStream<
  State extends object | unknown,
  I extends TObject,
  O extends TObject,
>(
  state: State,
  proc: Procedure<State, 'stream', I, O>,
  extendedContext?: Omit<ServiceContext, 'state'>,
): [Pushable<Static<I>>, Pushable<Static<O>>] {
  const rawInput = pushable<Static<I>>({ objectMode: true });
  const rawOutput = pushable<Static<O>>({ objectMode: true });

  const transportInput = pushable<TransportMessage<Static<I>>>({
    objectMode: true,
  });
  const transportOutput = pushable<TransportMessage<Static<O>>>({
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
  })();

  // handle
  (async () => {
    await proc.handler(
      { ...extendedContext, state },
      transportInput,
      transportOutput,
    );
    transportOutput.end();
  })();

  return [rawInput, rawOutput];
}

export function payloadToTransportMessage<Payload extends object>(
  payload: Payload,
  streamId?: string,
) {
  return msg(
    'client',
    'SERVER',
    'service',
    'procedure',
    streamId ?? 'stream',
    payload,
  );
}

export function createDummyTransportMessage(): OpaqueTransportMessage {
  return payloadToTransportMessage({
    msg: 'cool',
    test: Math.random(),
  });
}
