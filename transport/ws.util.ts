import http from 'http';
import WebSocket from 'isomorphic-ws';
import { WebSocketServer } from 'ws';
import { Transport } from './types';
import { OpaqueTransportMessage } from './message';
import { WebSocketTransport } from './ws';

export async function createWebSocketServer(server: http.Server) {
  return new WebSocketServer({ server });
}

export async function onServerReady(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve) => {
    server.listen(port, resolve);
  });
}

export async function createWsTransports(
  port: number,
  wss: WebSocketServer,
): Promise<[Transport, Transport]> {
  return new Promise((resolve) => {
    const clientSockPromise = createWebSocketClient(port);
    wss.on('connection', async (serverSock) => {
      resolve([
        new WebSocketTransport(await clientSockPromise, 'client'),
        new WebSocketTransport(serverSock, 'SERVER'),
      ]);
    });
  });
}

export async function waitForSocketReady(socket: WebSocket) {
  return new Promise<void>((resolve) => {
    socket.addEventListener('open', () => resolve());
  });
}

export async function createWebSocketClient(port: number) {
  const client = new WebSocket(`ws://localhost:${port}`);
  await waitForSocketReady(client);
  return client;
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
