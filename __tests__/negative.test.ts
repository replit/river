import { beforeEach, describe, expect, test, vi } from 'vitest';
import http from 'node:http';
import {
  cleanupTransports,
  testFinishesCleanly,
  waitFor,
} from './fixtures/cleanup';
import {
  createDummyTransportMessage,
  createLocalWebSocketClient,
  createWebSocketServer,
  onWsServerReady,
} from '../util/testHelpers';
import { WebSocketServerTransport } from '../transport/impls/ws/server';
import {
  ControlFlags,
  ControlMessageHandshakeRequestSchema,
  OpaqueTransportMessage,
  handshakeRequestMessage,
} from '../transport/message';
import { nanoid } from 'nanoid';
import { BinaryCodec } from '../codec';
import { Static } from '@sinclair/typebox';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import { ProtocolError } from '../transport/events';
import NodeWs from 'ws';
import { createPostTestCleanups } from './fixtures/cleanup';

describe('should handle incompatabilities', async () => {
  let server: http.Server;
  let port: number;
  let wss: NodeWs.Server;

  const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
  beforeEach(async () => {
    server = http.createServer();
    port = await onWsServerReady(server);
    wss = createWebSocketServer(server);

    return async () => {
      await postTestCleanup();
      wss.close();
      server.close();
    };
  });

  test('throws when sending after close', async () => {
    const clientTransport = new WebSocketClientTransport(
      () => Promise.resolve(createLocalWebSocketClient(port)),
      'client',
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    await clientTransport.connect(serverTransport.clientId);
    await waitFor(() => expect(serverTransport.connections.size).toBe(1));

    const errMock = vi.fn();
    clientTransport.addEventListener('protocolError', errMock);
    addPostTestCleanup(async () => {
      await cleanupTransports([clientTransport, serverTransport]);
    });

    clientTransport.close();
    expect(() =>
      clientTransport.send(
        serverTransport.clientId,
        createDummyTransportMessage(),
      ),
    ).toThrow();

    clientTransport.removeEventListener('protocolError', errMock);
    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });

  test('retrying single connection attempt should hit retry limit reached', async () => {
    const clientTransport = new WebSocketClientTransport(
      () => Promise.reject(new Error('fake connection failure')),
      'client',
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    const errMock = vi.fn();
    clientTransport.addEventListener('protocolError', errMock);
    addPostTestCleanup(async () => {
      clientTransport.removeEventListener('protocolError', errMock);
      await cleanupTransports([clientTransport, serverTransport]);
    });

    // try connecting and make sure we get the fake connection failure
    expect(errMock).toHaveBeenCalledTimes(0);
    const connectionPromise = clientTransport.connect(serverTransport.clientId);
    await vi.runAllTimersAsync();
    await connectionPromise;

    await waitFor(() => expect(errMock).toHaveBeenCalledTimes(1));
    expect(errMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProtocolError.RetriesExceeded,
      }),
    );

    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });

  test('calling connect consecutively should reuse the same connection', async () => {
    let connectCalls = 0;
    const clientTransport = new WebSocketClientTransport(
      () => {
        connectCalls++;
        return Promise.resolve(createLocalWebSocketClient(port));
      },
      'client',
      { attemptBudgetCapacity: 3 },
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    const errMock = vi.fn();
    clientTransport.addEventListener('protocolError', errMock);
    addPostTestCleanup(async () => {
      clientTransport.removeEventListener('protocolError', errMock);
      await cleanupTransports([clientTransport, serverTransport]);
    });

    for (let i = 0; i < 3; i++) {
      await clientTransport.connect(serverTransport.clientId);
    }

    expect(errMock).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(serverTransport.connections.size).toBe(1));
    expect(connectCalls).toBe(1);

    await testFinishesCleanly({
      clientTransports: [clientTransport],
      serverTransport,
    });
  });

  test('incorrect client handshake', async () => {
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    // add listeners
    const spy = vi.fn();
    const errMock = vi.fn();
    serverTransport.addEventListener('connectionStatus', spy);
    serverTransport.addEventListener('protocolError', errMock);
    addPostTestCleanup(async () => {
      serverTransport.removeEventListener('connectionStatus', spy);
      serverTransport.removeEventListener('protocolError', errMock);
      await cleanupTransports([serverTransport]);
    });

    const ws = createLocalWebSocketClient(port);
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(Buffer.from('bad handshake'));

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

    await testFinishesCleanly({
      clientTransports: [],
      serverTransport,
    });
  });

  test('seq number in the future should raise protocol error', async () => {
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');

    // add listeners
    const spy = vi.fn();
    const errMock = vi.fn();
    serverTransport.addEventListener('connectionStatus', spy);
    serverTransport.addEventListener('protocolError', errMock);
    addPostTestCleanup(async () => {
      serverTransport.removeEventListener('connectionStatus', spy);
      serverTransport.removeEventListener('protocolError', errMock);
      await cleanupTransports([serverTransport]);
    });

    const ws = createLocalWebSocketClient(port);
    await new Promise((resolve) => (ws.onopen = resolve));
    const requestMsg = handshakeRequestMessage({
      from: 'client',
      to: 'SERVER',
      expectedSessionState: {
        reconnect: false,
        nextExpectedSeq: 0,
      },
      sessionId: 'sessionId',
    });
    ws.send(BinaryCodec.toBuffer(requestMsg));

    // wait for both sides to be happy
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(errMock).toHaveBeenCalledTimes(0);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'connect',
      }),
    );

    // send one with bad sequence number
    const msg: OpaqueTransportMessage = {
      id: 'msgid',
      to: 'SERVER',
      from: 'client',
      seq: 50,
      ack: 0,
      controlFlags: ControlFlags.StreamOpenBit,
      streamId: 'streamid',
      payload: {},
    };
    ws.send(BinaryCodec.toBuffer(msg));

    await waitFor(() => expect(errMock).toHaveBeenCalledTimes(1));
    expect(errMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ProtocolError.MessageOrderingViolated,
      }),
    );

    await testFinishesCleanly({
      clientTransports: [],
      serverTransport,
    });
  });

  test('mismatched protocol version', async () => {
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    // add listeners
    const spy = vi.fn();
    const errMock = vi.fn();
    serverTransport.addEventListener('connectionStatus', spy);
    serverTransport.addEventListener('protocolError', errMock);
    addPostTestCleanup(async () => {
      serverTransport.removeEventListener('protocolError', errMock);
      serverTransport.removeEventListener('connectionStatus', spy);
      await cleanupTransports([serverTransport]);
    });

    const ws = createLocalWebSocketClient(port);
    await new Promise((resolve) => (ws.onopen = resolve));

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
        sessionId: 'sessionId',
      } satisfies Static<typeof ControlMessageHandshakeRequestSchema>,
    };
    ws.send(BinaryCodec.toBuffer(requestMsg));

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

    await testFinishesCleanly({
      clientTransports: [],
      serverTransport,
    });
  });
});
