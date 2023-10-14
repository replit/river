import http from 'http';
import { WebSocketServer } from 'ws';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  onServerReady,
  waitForMessage,
} from './util';

const port = 4444;
describe('sending and receiving across websockets works', () => {
  const server = http.createServer();
  let wss: WebSocketServer;
  beforeAll(async () => {
    await onServerReady(server, port);
    wss = await createWebSocketServer(server);
  });

  afterAll(() => {
    wss.clients.forEach((socket) => {
      socket.close();
    });
    server.close();
  });

  test('basic send/receive', async () => {
    const [clientTransport, serverTransport] = await createWsTransports(
      port,
      wss,
    );
    const msg = {
      msg: 'cool',
      test: 123,
    };

    clientTransport.send({
      id: '1',
      from: 'client',
      to: 'SERVER',
      serviceName: 'test',
      procedureName: 'test',
      payload: msg,
    });

    return expect(waitForMessage(serverTransport)).resolves.toStrictEqual(msg);
  });
});
