import http from 'http';
import WebSocket from 'isomorphic-ws';
import { WebSocketServer } from 'ws';
import { Transport } from './types';
import { WebSocketTransport } from './ws';
import { OpaqueTransportMessage } from './message';

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
