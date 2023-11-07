import http from 'http';
import { describe, test, expect, afterAll } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  onServerReady,
} from '../../testUtils';
import { nanoid } from 'nanoid';
import { waitForMessage } from '..';

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

describe('retry logic', async () => {
  const server = http.createServer();
  const port = await onServerReady(server);
  const wss = await createWebSocketServer(server);

  afterAll(() => {
    wss.clients.forEach((socket) => {
      socket.close();
    });
    server.close();
  });

  // TODO: right now, we only test client-side disconnects, we probably
  // need to also write tests for server-side crashes (but this involves clearing/restoring state)
  // not going to worry about this rn but for future

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

  test('ws transport is recreated after unclean disconnect', async () => {
    const [clientTransport, serverTransport] = createWsTransports(port, wss);
    const msg1 = getMsg();
    const msg2 = getMsg();

    clientTransport.send(msg1);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg1.id),
    ).resolves.toStrictEqual(msg1.payload);

    clientTransport.ws?.terminate();
    clientTransport.send(msg2);
    return expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg2.id),
    ).resolves.toStrictEqual(msg2.payload);
  });

  test('ws transport is not recreated after manually closing', async () => {
    const [clientTransport, serverTransport] = createWsTransports(port, wss);
    const msg1 = getMsg();
    const msg2 = getMsg();

    clientTransport.send(msg1);
    await expect(
      waitForMessage(serverTransport, (recv) => recv.id === msg1.id),
    ).resolves.toStrictEqual(msg1.payload);

    clientTransport.close();
    return expect(() => clientTransport.send(msg2)).toThrow(
      new Error('ws is destroyed, cant send'),
    );
  });
});
