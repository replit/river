import { afterAll, describe, expect, test, vi } from 'vitest';
import http from 'node:http';
import { testFinishesCleanly, waitFor } from './fixtures/cleanup';
import {
  createLocalWebSocketClient,
  createWebSocketServer,
  onWsServerReady,
} from '../util/testHelpers';
import { WebSocketServerTransport } from '../transport/impls/ws/server';
import { ControlMessageHandshakeRequestSchema } from '../transport/message';
import { nanoid } from 'nanoid';
import { NaiveJsonCodec } from '../codec';
import { Static } from '@sinclair/typebox';

describe('should handle incompatabilities', async () => {
  const server = http.createServer();
  const port = await onWsServerReady(server);
  const wss = createWebSocketServer(server);

  afterAll(() => {
    wss.close();
    server.close();
  });

  test('incorrect handshake', async () => {
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    // add listeners
    const spy = vi.fn();
    serverTransport.addEventListener('connectionStatus', spy);

    const ws = createLocalWebSocketClient(port);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send('bad handshake');

    // should never connect
    // ws should be closed
    expect(serverTransport.connections.size).toBe(0);
    expect(spy).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(ws.readyState).toBe(ws.CLOSED));

    // cleanup
    serverTransport.removeEventListener('connectionStatus', spy);
    await testFinishesCleanly({ clientTransports: [], serverTransport });
  });

  test('mismatched protocol version', async () => {
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    // add listeners
    const spy = vi.fn();
    serverTransport.addEventListener('connectionStatus', spy);

    const ws = createLocalWebSocketClient(port);
    await new Promise((resolve) => ws.on('open', resolve));

    const clientInstanceId = nanoid();
    const requestMsg = {
      id: nanoid(),
      from: 'client',
      to: 'SERVER',
      seq: 0,
      ack: 0,
      streamId: nanoid(),
      controlFlags: 0,
      payload: {
        type: 'HANDSHAKE_REQ',
        protocolVersion: 'v0' as 'v1', // make types happy
        instanceId: clientInstanceId,
      } satisfies Static<typeof ControlMessageHandshakeRequestSchema>,
    };
    ws.send(NaiveJsonCodec.toBuffer(requestMsg));

    // should never connect
    // ws should be closed
    expect(serverTransport.connections.size).toBe(0);
    expect(spy).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(ws.readyState).toBe(ws.CLOSED));

    // cleanup
    serverTransport.removeEventListener('connectionStatus', spy);
    await testFinishesCleanly({ clientTransports: [], serverTransport });
  });
});
