import { assert, beforeEach, describe, expect, test, vi } from 'vitest';
import http from 'node:http';
import {
  cleanupTransports,
  testFinishesCleanly,
  waitFor,
} from './fixtures/cleanup';
import {
  createLocalWebSocketClient,
  createWebSocketServer,
  numberOfConnections,
  onWsServerReady,
} from '../util/testHelpers';
import { WebSocketServerTransport } from '../transport/impls/ws/server';
import {
  ControlFlags,
  ControlMessageHandshakeRequestSchema,
  OpaqueTransportMessage,
  handshakeRequestMessage,
} from '../transport/message';
import { NaiveJsonCodec } from '../codec';
import { Static } from '@sinclair/typebox';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import { ProtocolError } from '../transport/events';
import NodeWs from 'ws';
import { createPostTestCleanups } from './fixtures/cleanup';
import { generateId } from '../transport/id';

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

  test('cannot get a bound send function on a closed transport', async () => {
    const clientTransport = new WebSocketClientTransport(
      () => Promise.resolve(createLocalWebSocketClient(port)),
      'client',
    );
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    addPostTestCleanup(async () => {
      await cleanupTransports([clientTransport, serverTransport]);
    });

    clientTransport.connect(serverTransport.clientId);
    const clientSession = clientTransport.sessions.get(
      serverTransport.clientId,
    );
    assert(clientSession);

    clientTransport.close();
    expect(() =>
      clientTransport.getSessionBoundSendFn(
        serverTransport.clientId,
        clientSession.id,
      ),
    ).toThrow();

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
    clientTransport.connect(serverTransport.clientId);
    await vi.runAllTimersAsync();

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
      clientTransport.connect(serverTransport.clientId);
    }

    expect(errMock).toHaveBeenCalledTimes(0);
    await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));
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
    serverTransport.addEventListener('sessionStatus', spy);
    serverTransport.addEventListener('protocolError', errMock);
    addPostTestCleanup(async () => {
      serverTransport.removeEventListener('sessionStatus', spy);
      serverTransport.removeEventListener('protocolError', errMock);
      await cleanupTransports([serverTransport]);
    });

    const ws = createLocalWebSocketClient(port);
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(Buffer.from('bad handshake'));

    // should never connect
    // ws should be closed
    await waitFor(() => expect(ws.readyState).toBe(ws.CLOSED));
    expect(numberOfConnections(serverTransport)).toBe(0);
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

  test('seq number in the future should close connection', async () => {
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');

    // add listeners
    const spy = vi.fn();
    const errMock = vi.fn();
    serverTransport.addEventListener('sessionStatus', spy);
    serverTransport.addEventListener('protocolError', errMock);
    addPostTestCleanup(async () => {
      serverTransport.removeEventListener('sessionStatus', spy);
      serverTransport.removeEventListener('protocolError', errMock);
      await cleanupTransports([serverTransport]);
    });

    const ws = createLocalWebSocketClient(port);
    await new Promise((resolve) => (ws.onopen = resolve));
    const requestMsg = handshakeRequestMessage({
      from: 'client',
      to: 'SERVER',
      expectedSessionState: {
        nextExpectedSeq: 0,
        nextSentSeq: 0,
      },
      sessionId: 'sessionId',
    });
    ws.send(NaiveJsonCodec.toBuffer(requestMsg));

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
    ws.send(NaiveJsonCodec.toBuffer(msg));

    await waitFor(() => ws.readyState === ws.CLOSED);
    expect(serverTransport.sessions.size).toBe(1);

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
    serverTransport.addEventListener('sessionStatus', spy);
    serverTransport.addEventListener('protocolError', errMock);
    addPostTestCleanup(async () => {
      serverTransport.removeEventListener('protocolError', errMock);
      serverTransport.removeEventListener('sessionStatus', spy);
      await cleanupTransports([serverTransport]);
    });

    const ws = createLocalWebSocketClient(port);
    await new Promise((resolve) => (ws.onopen = resolve));

    const requestMsg = {
      id: generateId(),
      from: 'client',
      to: 'SERVER',
      seq: 0,
      ack: 0,
      streamId: generateId(),
      controlFlags: 0,
      payload: {
        type: 'HANDSHAKE_REQ',
        protocolVersion: 'v0',
        sessionId: 'sessionId',
        expectedSessionState: {
          nextExpectedSeq: 0,
          nextSentSeq: 0,
        },
      } satisfies Static<typeof ControlMessageHandshakeRequestSchema>,
    };
    ws.send(NaiveJsonCodec.toBuffer(requestMsg));

    // should never connect
    // ws should be closed
    await waitFor(() => expect(ws.readyState).toBe(ws.CLOSED));
    expect(numberOfConnections(serverTransport)).toBe(0);
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
