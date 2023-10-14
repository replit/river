import http from 'http';
import WebSocket from 'isomorphic-ws';
import { WebSocketServer } from 'ws';
import { Transport } from './types';
import { WebSocketTransport } from './ws';
import { OpaqueTransportMessage } from './message';

export async function createWebSocketServer(server: http.Server) {
  return new WebSocketServer({ server });
}

export async function onServerReady(
  server: http.Server,
  port: number,
): Promise<void> {
  return new Promise((resolve) => {
    server.listen(port, resolve);
  });
}

export async function createLocalWebSocketClient(port: number) {
  return new WebSocket(`ws://localhost:${port}`);
}

export async function createWsTransports(
  port: number,
  wss: WebSocketServer,
): Promise<[WebSocketTransport, WebSocketTransport]> {
  return new Promise((resolve) => {
    const clientSockPromise = createLocalWebSocketClient(port);
    wss.on('connection', async (serverSock) => {
      resolve([
        new WebSocketTransport(() => clientSockPromise, 'client'),
        new WebSocketTransport(() => Promise.resolve(serverSock), 'SERVER'),
      ]);
    });
  });
}

export async function waitForMessage(
  t: Transport,
  filter?: (msg: OpaqueTransportMessage) => boolean,
) {
  return new Promise((resolve, _reject) => {
    function onMessage(msg: OpaqueTransportMessage) {
      if (!filter || filter?.(msg)) {
        resolve(msg.payload);
        t.removeMessageListener(onMessage);
      }
    }

    t.addMessageListener(onMessage);
  });
}
