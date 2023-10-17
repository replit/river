import http from 'http';
import { describe, test, expect, afterAll } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  onServerReady,
  waitForMessage,
} from './util';
import { nanoid } from 'nanoid';

const getMsg = () => ({
  id: nanoid(),
  from: 'client',
  to: 'SERVER',
  serviceName: 'test',
  procedureName: 'test',
  payload: {
    msg: 'cool',
    test: Math.random(),
  },
});

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
    const [clientTransport, serverTransport] = createWsTransports(port, wss);

    const msg = getMsg();
    clientTransport.send(msg);
    return expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg.id),
    ).resolves.toStrictEqual(msg.payload);
  });
});

describe.only('retry logic', async () => {
  const server = http.createServer();
  const port = await onServerReady(server);
  const wss = await createWebSocketServer(server);

  afterAll(() => {
    wss.clients.forEach((socket) => {
      socket.close();
    });
    server.close();
  });

  test('ws transport is recreated after clean disconnect', async () => {
    const [clientTransport, serverTransport] = createWsTransports(port, wss);

    const msg1 = getMsg();
    const msg2 = getMsg();

    clientTransport.send(msg1);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg1.id),
    ).resolves.toStrictEqual(msg1.payload);

    clientTransport.ws?.close();
    clientTransport.send(msg2);
    return expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg2.id),
    ).resolves.toStrictEqual(msg2.payload);
  });

  // test('ws transport is recreated after unclean disconnect', async () => {
  //   const [clientTransport, serverTransport] = await createWsTransports(
  //     port,
  //     wss,
  //   );
  //
  //   const msg1 = getMsg();
  //   const msg2 = getMsg();
  //
  //   clientTransport.send(msg1);
  //   await expect(
  //     waitForMessage(serverTransport, (recv) => recv.id === msg1.id),
  //   ).resolves.toStrictEqual(msg1.payload);
  //
  //   clientTransport.ws?.close();
  //   clientTransport.send(msg2);
  //   return expect(
  //     waitForMessage(serverTransport, (recv) => recv.id === msg2.id),
  //   ).resolves.toStrictEqual(msg2.payload);
  // });

  test('ws transport is not recreated after manually closing', () => {});
  test('message order is preserved in the face of disconnects', () => {});
});
