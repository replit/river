import http from 'http';
import { WebSocketServer } from 'ws';
import { WebSocketTransport } from './ws';
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import {
  createLocalWebSocketClient,
  createWebSocketServer,
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
    let serverTransport: WebSocketTransport | undefined;
    wss.on('connection', (conn) => {
      serverTransport = new WebSocketTransport(
        () => Promise.resolve(conn),
        'SERVER',
      );
    });
    const clientTransport = new WebSocketTransport(
      () => createLocalWebSocketClient(port),
      'client',
    );

    const msg = {
      msg: 'cool',
      test: 123,
    };

    await clientTransport.send({
      id: '1',
      from: 'client',
      to: 'SERVER',
      serviceName: 'test',
      procedureName: 'test',
      payload: msg,
    });

    expect(serverTransport).toBeTruthy();
    return expect(waitForMessage(serverTransport!)).resolves.toStrictEqual(msg);
  });
});
