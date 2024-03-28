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

    const errMock = vi.fn<[], unknown>();
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

  test('conn failure, retry limit reached', async () => {
    const clientTransport = new WebSocketClientTransport(
      () => Promise.reject(new Error('fake connection failure')),
      'client',
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    const errMock = vi.fn<[], unknown>();
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

    // connect and keep running all timers until completion
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await clientTransport.connect(serverTransport.clientId);
    await vi.runAllTimersAsync();

    expect(errMock).toHaveBeenCalledTimes(1);
    expect(errMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProtocolError.RetriesExceeded,
      }),
    );
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
