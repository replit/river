import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import http from 'node:http';
import { testFinishesCleanly, waitFor } from './fixtures/cleanup';
import {
  createDummyTransportMessage,
  createLocalWebSocketClient,
  createWebSocketServer,
  onWsServerReady,
} from '../util/testHelpers';
import { WebSocketServerTransport } from '../transport/impls/ws/server';
import { ControlMessageHandshakeRequestSchema } from '../transport/message';
import { nanoid } from 'nanoid';
import { NaiveJsonCodec } from '../codec';
import { Static } from '@sinclair/typebox';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import { ProtocolError } from '../transport/events';
import { defaultTransportOptions } from '../transport/transport';
import WebSocket from 'ws';

describe('should handle incompatabilities', async () => {
  const server = http.createServer();
  const port = await onWsServerReady(server);
  const wss = createWebSocketServer(server);

  afterAll(() => {
    wss.close();
    server.close();
  });

  test('emits use after destroy events', async () => {
    const clientTransport = new WebSocketClientTransport(
      () => Promise.resolve(createLocalWebSocketClient(port)),
      'client',
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    await clientTransport.connect(serverTransport.clientId);
    await waitFor(() => expect(serverTransport.connections.size).toBe(1));

    const errMock = vi.fn();
    clientTransport.addEventListener('protocolError', errMock);
    onTestFinished(async () => {
      clientTransport.removeEventListener('protocolError', errMock);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    clientTransport.destroy();
    const msg = createDummyTransportMessage();
    clientTransport.send(serverTransport.clientId, msg);

    expect(errMock).toHaveBeenCalledTimes(1);
    expect(errMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProtocolError.UseAfterDestroy,
      }),
    );
  });

  test('retrying single connection attempt should hit retry limit reached', async () => {
    const clientTransport = new WebSocketClientTransport(
      () => Promise.reject(new Error('fake connection failure')),
      'client',
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    const errMock = vi.fn();
    clientTransport.addEventListener('protocolError', errMock);
    onTestFinished(async () => {
      clientTransport.removeEventListener('protocolError', errMock);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    // try connecting and make sure we get the fake connection failure
    expect(errMock).toHaveBeenCalledTimes(0);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const connectionPromise = clientTransport.connect(serverTransport.clientId);
    await vi.runAllTimersAsync();
    await connectionPromise;

    await waitFor(() => expect(errMock).toHaveBeenCalledTimes(1));
    expect(errMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProtocolError.RetriesExceeded,
      }),
    );
  });

  test('repeated connections that close instantly causes retry limit to still be reached', async () => {
    const onConnMock = vi.fn();
    const immediatelyCloseWebSocket = (ws: WebSocket) => {
      onConnMock();
      ws.close();
    };

    wss.on('connection', immediatelyCloseWebSocket);
    const clientTransport = new WebSocketClientTransport(() => {
      const ws = createLocalWebSocketClient(port);
      return Promise.resolve(ws);
    }, 'client');
    clientTransport.tryReconnecting = false;

    const errMock = vi.fn();
    clientTransport.addEventListener('protocolError', errMock);
    onTestFinished(() => {
      wss.off('connection', immediatelyCloseWebSocket);
      clientTransport.removeEventListener('protocolError', errMock);
    });

    for (let i = 0; i < defaultTransportOptions.retryAttemptsMax; i++) {
      expect(onConnMock).toHaveBeenCalledTimes(i);
      await clientTransport.connect('SERVER');

      // wait for server to close
      await waitFor(() => expect(onConnMock).toHaveBeenCalledTimes(i + 1));
      await waitFor(() =>
        expect(clientTransport.inflightConnectionPromises.get('SERVER')).toBe(
          undefined,
        ),
      );
    }

    await clientTransport.connect('SERVER');
    expect(errMock).toHaveBeenCalledTimes(1);
  });

  test('incorrect client handshake', async () => {
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    // add listeners
    const spy = vi.fn();
    const errMock = vi.fn();
    serverTransport.addEventListener('connectionStatus', spy);
    serverTransport.addEventListener('protocolError', errMock);
    onTestFinished(async () => {
      serverTransport.removeEventListener('connectionStatus', spy);
      serverTransport.removeEventListener('protocolError', errMock);

      await testFinishesCleanly({
        clientTransports: [],
        serverTransport,
      });
    });

    const ws = createLocalWebSocketClient(port);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send('bad handshake');

    // should never connect
    // ws should be closed
    await waitFor(() => expect(ws.readyState).toBe(ws.CLOSED));
    expect(serverTransport.connections.size).toBe(0);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(errMock).toHaveBeenCalledTimes(1);
    expect(errMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProtocolError.HandshakeFailed,
      }),
    );
  });

  test('mismatched protocol version', async () => {
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    // add listeners
    const spy = vi.fn();
    const errMock = vi.fn();
    serverTransport.addEventListener('connectionStatus', spy);
    serverTransport.addEventListener('protocolError', errMock);
    onTestFinished(async () => {
      serverTransport.removeEventListener('protocolError', errMock);
      serverTransport.removeEventListener('connectionStatus', spy);

      await testFinishesCleanly({
        clientTransports: [],
        serverTransport,
      });
    });

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
        protocolVersion: 'v0',
        instanceId: clientInstanceId,
      } satisfies Static<typeof ControlMessageHandshakeRequestSchema>,
    };
    ws.send(NaiveJsonCodec.toBuffer(requestMsg));

    // should never connect
    // ws should be closed
    await waitFor(() => expect(ws.readyState).toBe(ws.CLOSED));
    expect(serverTransport.connections.size).toBe(0);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(errMock).toHaveBeenCalledTimes(1);
    expect(errMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProtocolError.HandshakeFailed,
      }),
    );
  });
});
