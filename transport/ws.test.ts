import http from 'http';
import { describe, test, expect, afterAll } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  onServerReady,
  waitForMessage,
} from './util';

describe('sending and receiving across websockets works', async () => {
  const server = http.createServer();
  const port = await onServerReady(server);
  const wss = await createWebSocketServer(server);

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

describe('retry logic', () => {
  test('ws transport is recreated after disconnect', () => {});
  test('ws transport is not recreated after manually closing', () => {});
  test('message order is preserved in the face of disconnects', () => {});
});
