import { describe, expect, test, vi } from 'vitest';
import {
  payloadToTransportMessage,
  testingSessionOptions,
} from '../../util/testHelpers';
import { waitFor } from '../../__tests__/fixtures/cleanup';
import {
  ControlFlags,
  ControlMessageAckSchema,
  handshakeRequestMessage,
} from '../message';
import { ERR_CONSUMED, Session, SessionState } from './common';
import { Static } from '@sinclair/typebox';
import { SessionHandshakingListeners } from './SessionHandshaking';
import { SessionConnectedListeners } from './SessionConnected';
import { SessionConnectingListeners } from './SessionConnecting';
import { SessionNoConnectionListeners } from './SessionNoConnection';
import { SessionStateMachine } from './transitions';
import { SessionPendingIdentification } from './SessionPendingIdentification';
import { Connection } from '../connection';

function persistedSessionState<ConnType extends Connection>(
  session: Session<ConnType>,
) {
  return {
    id: session.id,
    from: session.from,
    to: session.to,
    seq: session.seq,
    ack: session.ack,
    options: session.options,
    telemetry: session.telemetry,
  };
}

class MockConnection extends Connection {
  status: 'open' | 'closed' = 'open';
  send = vi.fn();

  close(): void {
    this.status = 'closed';
    this.closeListeners.forEach((cb) => cb());
  }

  emitData(msg: Uint8Array): void {
    this.dataListeners.forEach((cb) => cb(msg));
  }

  emitClose(): void {
    this.closeListeners.forEach((cb) => cb());
  }

  emitError(err: Error): void {
    this.errorListeners.forEach((cb) => cb(err));
    this.close();
  }
}

interface PendingMockConnectionHandle {
  pendingConn: Promise<MockConnection>;
  connect: () => void;
  error: (err: Error) => void;
}

function getPendingMockConnection(): PendingMockConnectionHandle {
  let resolve: (conn: MockConnection) => void;
  let reject: (err: Error) => void;
  return {
    pendingConn: new Promise<MockConnection>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
    connect: () => {
      resolve(new MockConnection());
    },
    error: (err: Error) => {
      reject(err);
    },
  };
}

function createSessionNoConnectionListeners(): SessionNoConnectionListeners {
  return {
    onSessionGracePeriodElapsed: vi.fn(),
  };
}

function createSessionConnectingListeners(): SessionConnectingListeners<MockConnection> {
  return {
    onConnectionEstablished: vi.fn(),
    onConnectionFailed: vi.fn(),
    onConnectionTimeout: vi.fn(),
  };
}

function createSessionHandshakingListeners(): SessionHandshakingListeners {
  return {
    onHandshake: vi.fn(),
    onConnectionClosed: vi.fn(),
    onConnectionErrored: vi.fn(),
    onHandshakeTimeout: vi.fn(),
  };
}

function createSessionConnectedListeners(): SessionConnectedListeners {
  return {
    onMessage: vi.fn(),
    onConnectionClosed: vi.fn(),
    onConnectionErrored: vi.fn(),
  };
}

function createSessionNoConnection() {
  const listeners = createSessionNoConnectionListeners();
  const session = SessionStateMachine.entrypoints.NoConnection(
    'to',
    'from',
    listeners,
    testingSessionOptions,
  );

  return { session, ...listeners };
}

function createSessionConnecting() {
  let session: Session<MockConnection> = createSessionNoConnection().session;
  const { pendingConn, connect, error } = getPendingMockConnection();
  const listeners = createSessionConnectingListeners();

  session = SessionStateMachine.transition.NoConnectionToConnecting(
    session,
    pendingConn,
    listeners,
  );

  return { session, connect, error, ...listeners };
}

async function createSessionHandshaking() {
  const sessionHandle = createSessionConnecting();
  let session: Session<MockConnection> = sessionHandle.session;
  const { connect } = sessionHandle;

  connect();
  const conn = await session.connPromise;
  const listeners = createSessionHandshakingListeners();
  session = SessionStateMachine.transition.ConnectingToHandshaking(
    session,
    conn,
    listeners,
  );

  return { session, ...listeners };
}

async function createSessionConnected() {
  const sessionHandle = await createSessionHandshaking();
  let session: Session<MockConnection> = sessionHandle.session;
  const listeners = createSessionConnectedListeners();

  session = SessionStateMachine.transition.HandshakingToConnected(
    session,
    listeners,
  );

  return { session, ...listeners };
}

function createSessionPendingIdentification() {
  const conn = new MockConnection();
  const listeners = createSessionHandshakingListeners();
  const session = SessionStateMachine.entrypoints.PendingIdentification(
    'from',
    conn,
    listeners,
    testingSessionOptions,
  );

  return { session, ...listeners };
}

describe('session state machine', () => {
  describe('initial state', () => {
    test('no connection', () => {
      const { session } = createSessionNoConnection();
      expect(session.state).toBe(SessionState.NoConnection);
    });

    test('connecting', async () => {
      const { session } = createSessionConnecting();
      expect(session.state).toBe(SessionState.Connecting);
    });

    test('handshaking', async () => {
      const { session } = await createSessionHandshaking();
      expect(session.state).toBe(SessionState.Handshaking);
    });

    test('connected', async () => {
      const { session } = await createSessionConnected();
      expect(session.state).toBe(SessionState.Connected);
    });

    test('pending identification', async () => {
      const { session } = createSessionPendingIdentification();
      expect(session.state).toBe(SessionState.PendingIdentification);
    });
  });

  describe('state transitions', () => {
    test('no connection -> connecting', async () => {
      const sessionHandle = createSessionNoConnection();
      let session: Session<MockConnection> = sessionHandle.session;
      expect(session.state).toBe(SessionState.NoConnection);
      const sessionStateToBePersisted = persistedSessionState(session);
      const onSessionGracePeriodElapsed =
        sessionHandle.onSessionGracePeriodElapsed;

      const { pendingConn } = getPendingMockConnection();
      const listeners = createSessionConnectingListeners();
      session = SessionStateMachine.transition.NoConnectionToConnecting(
        session,
        pendingConn,
        listeners,
      );

      expect(session.state).toBe(SessionState.Connecting);
      expect(listeners.onConnectionEstablished).not.toHaveBeenCalled();
      expect(listeners.onConnectionFailed).not.toHaveBeenCalled();
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(testingSessionOptions.sessionDisconnectGraceMs);
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
    });

    test('connecting -> handshaking', async () => {
      const sessionHandle = createSessionConnecting();
      let session: Session<MockConnection> = sessionHandle.session;
      const { connect } = sessionHandle;
      const sessionStateToBePersisted = persistedSessionState(session);
      const onConnectionTimeout = sessionHandle.onConnectionTimeout;

      connect();
      const conn = await session.connPromise;
      const listeners = createSessionHandshakingListeners();
      session = SessionStateMachine.transition.ConnectingToHandshaking(
        session,
        conn,
        listeners,
      );

      expect(session.state).toBe(SessionState.Handshaking);
      expect(onConnectionTimeout).not.toHaveBeenCalled();

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );

      // check handlers on the connection
      expect(conn.dataListeners.size).toBe(1);
      expect(conn.closeListeners.size).toBe(1);
      expect(conn.errorListeners.size).toBe(1);

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(testingSessionOptions.connectionTimeoutMs);
      expect(onConnectionTimeout).not.toHaveBeenCalled();
    });

    test('handshaking -> connected', async () => {
      const sessionHandle = await createSessionHandshaking();
      let session: Session<MockConnection> = sessionHandle.session;
      const oldListeners = {
        onHandshakeData: [...session.conn.dataListeners],
        onConnectionClosed: [...session.conn.closeListeners],
        onConnectionErrored: [...session.conn.errorListeners],
      };

      const sessionStateToBePersisted = persistedSessionState(session);
      const onHandshakeTimeout = sessionHandle.onHandshakeTimeout;

      const listeners = createSessionConnectedListeners();
      session = SessionStateMachine.transition.HandshakingToConnected(
        session,
        listeners,
      );

      expect(session.state).toBe(SessionState.Connected);
      expect(onHandshakeTimeout).not.toHaveBeenCalled();

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );

      // check handlers on the connection
      const conn = session.conn;
      expect(conn.dataListeners.size).toBe(1);
      expect(conn.closeListeners.size).toBe(1);
      expect(conn.errorListeners.size).toBe(1);

      // make sure the old listeners are removed
      for (const listener of oldListeners.onHandshakeData) {
        expect(conn.dataListeners.has(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionClosed) {
        expect(conn.closeListeners.has(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionErrored) {
        expect(conn.errorListeners.has(listener)).toBe(false);
      }

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(testingSessionOptions.handshakeTimeoutMs);
      expect(onHandshakeTimeout).not.toHaveBeenCalled();
    });

    test('pending -> connected', async () => {
      const sessionHandle = createSessionPendingIdentification();
      let session:
        | Session<MockConnection>
        | SessionPendingIdentification<MockConnection> = sessionHandle.session;

      const oldListeners = {
        onHandshake: [...session.conn.dataListeners],
        onConnectionClosed: [...session.conn.closeListeners],
        onConnectionErrored: [...session.conn.errorListeners],
      };

      const onHandshakeTimeout = sessionHandle.onHandshakeTimeout;
      const listeners = createSessionConnectedListeners();
      session = SessionStateMachine.transition.PendingIdentificationToConnected(
        session,
        'clientSessionId',
        'to',
        listeners,
      );

      expect(session.state).toBe(SessionState.Connected);
      expect(session.id).toBe('clientSessionId');
      expect(session.to).toBe('to');
      expect(onHandshakeTimeout).not.toHaveBeenCalled();

      // check handlers on the connection
      const conn = session.conn;
      expect(conn.dataListeners.size).toBe(1);
      expect(conn.closeListeners.size).toBe(1);
      expect(conn.errorListeners.size).toBe(1);

      // make sure the old listeners are removed
      for (const listener of oldListeners.onHandshake) {
        expect(conn.dataListeners.has(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionClosed) {
        expect(conn.closeListeners.has(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionErrored) {
        expect(conn.errorListeners.has(listener)).toBe(false);
      }

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(testingSessionOptions.handshakeTimeoutMs);
      expect(onHandshakeTimeout).not.toHaveBeenCalled();
    });

    test('connecting (conn failed) -> no connection', async () => {
      const sessionHandle = createSessionConnecting();
      let session: Session<MockConnection> = sessionHandle.session;
      const connPromise = session.connPromise;
      const { error } = sessionHandle;

      const onConnectionTimeout = sessionHandle.onConnectionTimeout;
      const sessionStateToBePersisted = persistedSessionState(session);
      error(new Error('test error'));

      const listeners = createSessionNoConnectionListeners();
      session = SessionStateMachine.transition.ConnectingToNoConnection(
        session,
        listeners,
      );

      expect(session.state).toBe(SessionState.NoConnection);
      expect(onConnectionTimeout).not.toHaveBeenCalled();
      await expect(connPromise).rejects.toThrowError('test error');

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(testingSessionOptions.connectionTimeoutMs);
      expect(onConnectionTimeout).not.toHaveBeenCalled();
    });

    test('connecting (conn ok) -> no connection', async () => {
      const sessionHandle = createSessionConnecting();
      let session: Session<MockConnection> = sessionHandle.session;
      const connPromise = session.connPromise;
      const { connect } = sessionHandle;

      const onConnectionTimeout = sessionHandle.onConnectionTimeout;
      const sessionStateToBePersisted = persistedSessionState(session);
      connect();

      const listeners = createSessionNoConnectionListeners();
      session = SessionStateMachine.transition.ConnectingToNoConnection(
        session,
        listeners,
      );

      expect(session.state).toBe(SessionState.NoConnection);
      expect(onConnectionTimeout).not.toHaveBeenCalled();
      const conn = await connPromise;
      expect(conn.status).toBe('closed');

      // should not have any listeners
      expect(conn.dataListeners.size).toBe(0);
      expect(conn.closeListeners.size).toBe(0);
      expect(conn.errorListeners.size).toBe(0);

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(testingSessionOptions.connectionTimeoutMs);
      expect(onConnectionTimeout).not.toHaveBeenCalled();
    });

    test('handshaking -> no connection', async () => {
      const sessionHandle = await createSessionHandshaking();
      let session: Session<MockConnection> = sessionHandle.session;
      const conn = session.conn;
      const oldListeners = {
        onHandshakeData: [...conn.dataListeners],
        onConnectionClosed: [...conn.closeListeners],
        onConnectionErrored: [...conn.errorListeners],
      };

      const onHandshakeTimeout = sessionHandle.onHandshakeTimeout;
      const listeners = createSessionNoConnectionListeners();
      const sessionStateToBePersisted = persistedSessionState(session);
      session = SessionStateMachine.transition.HandshakingToNoConnection(
        session,
        listeners,
      );

      expect(session.state).toBe(SessionState.NoConnection);
      expect(onHandshakeTimeout).not.toHaveBeenCalled();
      expect(conn.status).toBe('closed');

      // check handlers on the connection
      expect(conn.dataListeners.size).toBe(0);
      expect(conn.closeListeners.size).toBe(0);
      expect(conn.errorListeners.size).toBe(0);

      // make sure the old listeners are removed
      for (const listener of oldListeners.onHandshakeData) {
        expect(conn.dataListeners.has(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionClosed) {
        expect(conn.closeListeners.has(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionErrored) {
        expect(conn.errorListeners.has(listener)).toBe(false);
      }

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(testingSessionOptions.handshakeTimeoutMs);
      expect(onHandshakeTimeout).not.toHaveBeenCalled();
    });

    test('connected -> no connection', async () => {
      const sessionHandle = await createSessionConnected();
      let session: Session<MockConnection> = sessionHandle.session;
      const conn = session.conn;
      const oldListeners = {
        onMessageData: [...conn.dataListeners],
        onConnectionClosed: [...conn.closeListeners],
        onConnectionErrored: [...conn.errorListeners],
      };

      const listeners = createSessionNoConnectionListeners();
      const sessionStateToBePersisted = persistedSessionState(session);
      session = SessionStateMachine.transition.ConnectedToNoConnection(
        session,
        listeners,
      );

      expect(session.state).toBe(SessionState.NoConnection);
      expect(conn.status).toBe('closed');

      // check handlers on the connection
      expect(conn.dataListeners.size).toBe(0);
      expect(conn.closeListeners.size).toBe(0);
      expect(conn.errorListeners.size).toBe(0);

      // make sure the old listeners are removed
      for (const listener of oldListeners.onMessageData) {
        expect(conn.dataListeners.has(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionClosed) {
        expect(conn.closeListeners.has(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionErrored) {
        expect(conn.errorListeners.has(listener)).toBe(false);
      }

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );
    });
  });

  describe('state transitions preserve buffer, seq, ack', () => {
    test('no connection -> connecting', async () => {
      const sessionHandle = createSessionNoConnection();
      let session: Session<MockConnection> = sessionHandle.session;
      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      const { pendingConn } = getPendingMockConnection();
      session = SessionStateMachine.transition.NoConnectionToConnecting(
        session,
        pendingConn,
        createSessionConnectingListeners(),
      );

      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('connecting -> handshaking', async () => {
      const sessionHandle = createSessionConnecting();
      let session: Session<MockConnection> = sessionHandle.session;
      const { connect } = sessionHandle;
      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      connect();
      const conn = await session.connPromise;
      session = SessionStateMachine.transition.ConnectingToHandshaking(
        session,
        conn,
        createSessionHandshakingListeners(),
      );

      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('handshaking -> connected', async () => {
      const sessionHandle = await createSessionHandshaking();
      let session: Session<MockConnection> = sessionHandle.session;
      const sendBuffer = session.sendBuffer;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      session = SessionStateMachine.transition.HandshakingToConnected(
        session,
        createSessionConnectedListeners(),
      );

      expect(sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('connecting -> no connection', async () => {
      const sessionHandle = createSessionConnecting();
      let session: Session<MockConnection> = sessionHandle.session;
      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      session = SessionStateMachine.transition.ConnectingToNoConnection(
        session,
        createSessionNoConnectionListeners(),
      );

      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('handshaking -> no connection', async () => {
      const sessionHandle = await createSessionHandshaking();
      let session: Session<MockConnection> = sessionHandle.session;
      const sendBuffer = session.sendBuffer;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      session = SessionStateMachine.transition.HandshakingToNoConnection(
        session,
        createSessionNoConnectionListeners(),
      );

      expect(sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('connected -> no connection', async () => {
      const sessionHandle = await createSessionConnected();
      let session: Session<MockConnection> = sessionHandle.session;
      const sendBuffer = session.sendBuffer;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      session = SessionStateMachine.transition.ConnectedToNoConnection(
        session,
        createSessionNoConnectionListeners(),
      );

      expect(sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });
  });

  describe('stale handles post-transition', () => {
    test('no connection -> connecting: stale handle', async () => {
      const sessionHandle = createSessionNoConnection();
      const session: Session<MockConnection> = sessionHandle.session;
      const { pendingConn } = getPendingMockConnection();
      const listeners = createSessionConnectingListeners();

      SessionStateMachine.transition.NoConnectionToConnecting(
        session,
        pendingConn,
        listeners,
      );

      // doing anything on the old session should throw
      expect(() => session.id).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });

    test('connecting -> handshaking: stale handle', async () => {
      const sessionHandle = createSessionConnecting();
      const session: Session<MockConnection> = sessionHandle.session;
      const { connect } = sessionHandle;

      connect();
      const conn = await session.connPromise;
      const listeners = createSessionHandshakingListeners();
      SessionStateMachine.transition.ConnectingToHandshaking(
        session,
        conn,
        listeners,
      );

      // doing anything on the old session should throw
      expect(() => session.id).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });

    test('handshaking -> connected: stale handle', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session: Session<MockConnection> = sessionHandle.session;
      const listeners = createSessionConnectedListeners();
      SessionStateMachine.transition.HandshakingToConnected(session, listeners);

      // doing anything on the old session should throw
      expect(() => session.id).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });

    test('pending -> connected: stale handle', async () => {
      const sessionHandle = createSessionPendingIdentification();
      const session:
        | Session<MockConnection>
        | SessionPendingIdentification<MockConnection> = sessionHandle.session;
      const listeners = createSessionConnectedListeners();
      SessionStateMachine.transition.PendingIdentificationToConnected(
        session,
        'clientSessionId',
        'to',
        listeners,
      );

      // doing anything on the old session should throw
      expect(() => session.conn).toThrowError(ERR_CONSUMED);
    });

    test('connecting -> no connection: stale handle', async () => {
      const sessionHandle = createSessionConnecting();
      const session: Session<MockConnection> = sessionHandle.session;
      const listeners = createSessionNoConnectionListeners();
      SessionStateMachine.transition.ConnectingToNoConnection(
        session,
        listeners,
      );

      // doing anything on the old session should throw
      expect(() => session.id).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });

    test('handshaking -> no connection: stale handle', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session: Session<MockConnection> = sessionHandle.session;
      const listeners = createSessionNoConnectionListeners();
      SessionStateMachine.transition.HandshakingToNoConnection(
        session,
        listeners,
      );

      // doing anything on the old session should throw
      expect(() => session.id).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });

    test('connected -> no connection: stale handle', async () => {
      const sessionHandle = await createSessionConnected();
      const session: Session<MockConnection> = sessionHandle.session;
      const listeners = createSessionNoConnectionListeners();
      SessionStateMachine.transition.ConnectedToNoConnection(
        session,
        listeners,
      );

      // doing anything on the old session should throw
      expect(() => session.id).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });
  });

  describe('close cleanup', () => {
    test('no connection', async () => {
      const sessionHandle = createSessionNoConnection();
      const session: Session<MockConnection> = sessionHandle.session;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      session.close();
      expect(session.sendBuffer.length).toBe(0);
    });

    test('connecting', async () => {
      const sessionHandle = createSessionConnecting();
      const session: Session<MockConnection> = sessionHandle.session;
      const { connect } = sessionHandle;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      connect();
      session.close();
      expect(session.sendBuffer.length).toBe(0);
      const conn = await session.connPromise;
      expect(conn.status).toBe('closed');
    });

    test('handshaking', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session: Session<MockConnection> = sessionHandle.session;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      session.close();
      expect(session.sendBuffer.length).toBe(0);
      const conn = session.conn;
      expect(conn.status).toBe('closed');
    });

    test('connected', async () => {
      const sessionHandle = await createSessionConnected();
      const session: Session<MockConnection> = sessionHandle.session;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      session.close();
      expect(session.sendBuffer.length).toBe(0);
      const conn = session.conn;
      expect(conn.status).toBe('closed');
    });

    test('pending identification', async () => {
      const sessionHandle = createSessionPendingIdentification();
      const session: SessionPendingIdentification<MockConnection> =
        sessionHandle.session;

      session.close();
      const conn = session.conn;
      expect(conn.status).toBe('closed');
    });
  });

  describe('event listeners', () => {
    test('connecting event listeners: connectionEstablished', async () => {
      const sessionHandle = createSessionConnecting();
      const session: Session<MockConnection> = sessionHandle.session;
      const {
        connect,
        onConnectionEstablished: connectionEstablished,
        onConnectionFailed: connectionFailed,
      } = sessionHandle;
      expect(session.state).toBe(SessionState.Connecting);
      expect(connectionEstablished).not.toHaveBeenCalled();
      expect(connectionFailed).not.toHaveBeenCalled();

      connect();

      await waitFor(async () => {
        expect(connectionEstablished).toHaveBeenCalled();
        expect(connectionEstablished).toHaveBeenCalledWith(
          await session.connPromise,
        );
        expect(connectionFailed).not.toHaveBeenCalled();
      });

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.Connecting);
    });

    test('connecting event listeners: connectionFailed', async () => {
      const sessionHandle = createSessionConnecting();
      const session: Session<MockConnection> = sessionHandle.session;
      const { error, onConnectionEstablished, onConnectionFailed } =
        sessionHandle;
      expect(session.state).toBe(SessionState.Connecting);
      expect(onConnectionEstablished).not.toHaveBeenCalled();
      expect(onConnectionFailed).not.toHaveBeenCalled();

      error(new Error('test error'));

      await waitFor(async () => {
        expect(onConnectionFailed).toHaveBeenCalled();
        expect(onConnectionFailed).toHaveBeenCalledWith(
          new Error('test error'),
        );
        expect(onConnectionEstablished).not.toHaveBeenCalled();
      });

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.Connecting);
    });

    test('connecting event listeners: connectionTimeout', async () => {
      const sessionHandle = createSessionConnecting();
      const session: Session<MockConnection> = sessionHandle.session;
      const {
        onConnectionEstablished,
        onConnectionFailed,
        onConnectionTimeout,
      } = sessionHandle;
      expect(session.state).toBe(SessionState.Connecting);
      expect(onConnectionEstablished).not.toHaveBeenCalled();
      expect(onConnectionFailed).not.toHaveBeenCalled();
      expect(onConnectionTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(testingSessionOptions.connectionTimeoutMs);
      expect(onConnectionTimeout).toHaveBeenCalled();
      expect(onConnectionEstablished).not.toHaveBeenCalled();
      expect(onConnectionFailed).not.toHaveBeenCalled();
    });

    test('handshaking event listeners: connectionErrored', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session: Session<MockConnection> = sessionHandle.session;
      const conn = session.conn;
      const { onHandshake, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.Handshaking);
      expect(onHandshake).not.toHaveBeenCalled();
      expect(onConnectionClosed).not.toHaveBeenCalled();
      expect(onConnectionErrored).not.toHaveBeenCalled();

      conn.emitError(new Error('test error'));

      await waitFor(async () => {
        expect(onConnectionErrored).toHaveBeenCalledTimes(1);
        expect(onConnectionErrored).toHaveBeenCalledWith(
          new Error('test error'),
        );
        expect(onConnectionClosed).toHaveBeenCalledTimes(1);
        expect(onHandshake).not.toHaveBeenCalled();
      });

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.Handshaking);
    });

    test('handshaking event listeners: connectionClosed', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session: Session<MockConnection> = sessionHandle.session;
      const conn = session.conn;
      const { onHandshake, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.Handshaking);
      expect(onHandshake).not.toHaveBeenCalled();
      expect(onConnectionClosed).not.toHaveBeenCalled();
      expect(onConnectionErrored).not.toHaveBeenCalled();

      conn.emitClose();

      await waitFor(async () => {
        expect(onConnectionClosed).toHaveBeenCalledTimes(1);
        expect(onConnectionErrored).not.toHaveBeenCalled();
        expect(onHandshake).not.toHaveBeenCalled();
      });

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.Handshaking);
    });

    test('handshaking event listeners: onHandshakeData', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session: Session<MockConnection> = sessionHandle.session;
      const { onHandshake, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.Handshaking);
      expect(onHandshake).not.toHaveBeenCalled();
      expect(onConnectionClosed).not.toHaveBeenCalled();
      expect(onConnectionErrored).not.toHaveBeenCalled();

      session.conn.emitData(
        session.options.codec.toBuffer(
          handshakeRequestMessage({
            from: 'from',
            to: 'to',
            sessionId: 'clientSessionId',
            expectedSessionState: {
              reconnect: false,
              nextExpectedSeq: 0,
            },
          }),
        ),
      );

      await waitFor(async () => {
        expect(onHandshake).toHaveBeenCalledTimes(1);
        expect(onConnectionClosed).not.toHaveBeenCalled();
        expect(onConnectionErrored).not.toHaveBeenCalled();
      });

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.Handshaking);
    });

    test('handshaking event listeners: handshakeTimeout', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session: Session<MockConnection> = sessionHandle.session;
      const {
        onHandshake,
        onConnectionClosed,
        onConnectionErrored,
        onHandshakeTimeout,
      } = sessionHandle;
      expect(session.state).toBe(SessionState.Handshaking);
      expect(onHandshake).not.toHaveBeenCalled();
      expect(onConnectionClosed).not.toHaveBeenCalled();
      expect(onConnectionErrored).not.toHaveBeenCalled();

      vi.advanceTimersByTime(testingSessionOptions.handshakeTimeoutMs);

      await waitFor(async () => {
        expect(onHandshake).not.toHaveBeenCalled();
        expect(onConnectionClosed).not.toHaveBeenCalled();
        expect(onConnectionErrored).not.toHaveBeenCalled();
        expect(onHandshakeTimeout).toHaveBeenCalledTimes(1);
      });
    });

    test('pending identification event listeners: connectionErrored', async () => {
      const sessionHandle = createSessionPendingIdentification();
      const session:
        | Session<MockConnection>
        | SessionPendingIdentification<MockConnection> = sessionHandle.session;

      const conn = session.conn;
      const { onHandshake, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.PendingIdentification);
      expect(onHandshake).not.toHaveBeenCalled();
      expect(onConnectionClosed).not.toHaveBeenCalled();
      expect(onConnectionErrored).not.toHaveBeenCalled();

      conn.emitError(new Error('test error'));

      await waitFor(async () => {
        expect(onConnectionErrored).toHaveBeenCalledTimes(1);
        expect(onConnectionErrored).toHaveBeenCalledWith(
          new Error('test error'),
        );
        expect(onConnectionClosed).toHaveBeenCalledTimes(1);
        expect(onHandshake).not.toHaveBeenCalled();
      });

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.PendingIdentification);
    });

    test('pending identification event listeners: connectionClosed', async () => {
      const sessionHandle = createSessionPendingIdentification();
      const session:
        | Session<MockConnection>
        | SessionPendingIdentification<MockConnection> = sessionHandle.session;

      const conn = session.conn;
      const { onHandshake, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.PendingIdentification);
      expect(onHandshake).not.toHaveBeenCalled();
      expect(onConnectionClosed).not.toHaveBeenCalled();
      expect(onConnectionErrored).not.toHaveBeenCalled();

      conn.emitClose();

      await waitFor(async () => {
        expect(onConnectionClosed).toHaveBeenCalledTimes(1);
        expect(onConnectionErrored).not.toHaveBeenCalled();
        expect(onHandshake).not.toHaveBeenCalled();
      });

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.PendingIdentification);
    });

    test('pending identification event listeners: onHandshakeData', async () => {
      const sessionHandle = createSessionPendingIdentification();
      const session:
        | Session<MockConnection>
        | SessionPendingIdentification<MockConnection> = sessionHandle.session;

      const { onHandshake, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.PendingIdentification);
      expect(onHandshake).not.toHaveBeenCalled();
      expect(onConnectionClosed).not.toHaveBeenCalled();
      expect(onConnectionErrored).not.toHaveBeenCalled();

      session.conn.emitData(
        session.options.codec.toBuffer(
          handshakeRequestMessage({
            from: 'from',
            to: 'to',
            sessionId: 'clientSessionId',
            expectedSessionState: {
              reconnect: false,
              nextExpectedSeq: 0,
            },
          }),
        ),
      );

      await waitFor(async () => {
        expect(onHandshake).toHaveBeenCalledTimes(1);
        expect(onConnectionClosed).not.toHaveBeenCalled();
        expect(onConnectionErrored).not.toHaveBeenCalled();
      });

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.PendingIdentification);
    });

    test('pending identification event listeners: handshakeTimeout', async () => {
      const sessionHandle = createSessionPendingIdentification();
      const session:
        | Session<MockConnection>
        | SessionPendingIdentification<MockConnection> = sessionHandle.session;

      const {
        onHandshake,
        onConnectionClosed,
        onConnectionErrored,
        onHandshakeTimeout,
      } = sessionHandle;
      expect(session.state).toBe(SessionState.PendingIdentification);
      expect(onHandshake).not.toHaveBeenCalled();
      expect(onConnectionClosed).not.toHaveBeenCalled();
      expect(onConnectionErrored).not.toHaveBeenCalled();

      vi.advanceTimersByTime(testingSessionOptions.handshakeTimeoutMs);

      await waitFor(async () => {
        expect(onHandshake).not.toHaveBeenCalled();
        expect(onConnectionClosed).not.toHaveBeenCalled();
        expect(onConnectionErrored).not.toHaveBeenCalled();
        expect(onHandshakeTimeout).toHaveBeenCalledTimes(1);
      });
    });

    test('connected event listeners: connectionErrored', async () => {
      const sessionHandle = await createSessionConnected();
      const session: Session<MockConnection> = sessionHandle.session;
      const conn = session.conn;
      const { onMessage, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.Connected);
      expect(onMessage).not.toHaveBeenCalled();
      expect(onConnectionClosed).not.toHaveBeenCalled();
      expect(onConnectionErrored).not.toHaveBeenCalled();

      conn.emitError(new Error('test error'));

      await waitFor(async () => {
        expect(onConnectionErrored).toHaveBeenCalledTimes(1);
        expect(onConnectionErrored).toHaveBeenCalledWith(
          new Error('test error'),
        );
        expect(onConnectionClosed).toHaveBeenCalledTimes(1);
        expect(onMessage).not.toHaveBeenCalled();
      });

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.Connected);
    });

    test('connected event listeners: connectionClosed', async () => {
      const sessionHandle = await createSessionConnected();
      const session: Session<MockConnection> = sessionHandle.session;
      const conn = session.conn;
      const { onMessage, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.Connected);
      expect(onMessage).not.toHaveBeenCalled();
      expect(onConnectionClosed).not.toHaveBeenCalled();
      expect(onConnectionErrored).not.toHaveBeenCalled();

      conn.emitClose();

      await waitFor(async () => {
        expect(onConnectionClosed).toHaveBeenCalledTimes(1);
        expect(onConnectionErrored).not.toHaveBeenCalled();
        expect(onMessage).not.toHaveBeenCalled();
      });

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.Connected);
    });

    test('connected event listeners: onMessageData', async () => {
      const sessionHandle = await createSessionConnected();
      const session: Session<MockConnection> = sessionHandle.session;
      const { onMessage, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.Connected);
      expect(onMessage).not.toHaveBeenCalled();
      expect(onConnectionClosed).not.toHaveBeenCalled();
      expect(onConnectionErrored).not.toHaveBeenCalled();

      const msg = session.constructMsg(payloadToTransportMessage('hello'));
      session.conn.emitData(session.options.codec.toBuffer(msg));

      await waitFor(async () => {
        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(onConnectionClosed).not.toHaveBeenCalled();
        expect(onConnectionErrored).not.toHaveBeenCalled();
      });

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.Connected);
    });
  });

  describe('heartbeats', () => {
    test('active heartbeating works and is cleared on state transition', async () => {
      const sessionHandle = await createSessionConnected();
      const session: Session<MockConnection> = sessionHandle.session;
      const conn = session.conn;

      // wait for heartbeat timer
      session.startActiveHeartbeat();
      vi.advanceTimersByTime(testingSessionOptions.heartbeatIntervalMs);

      // make sure conn has received the heartbeat
      expect(conn.send).toHaveBeenCalledTimes(1);

      // transition to no connection
      const listeners = createSessionNoConnectionListeners();
      SessionStateMachine.transition.ConnectedToNoConnection(
        session,
        listeners,
      );

      // send another heartbeat
      vi.advanceTimersByTime(testingSessionOptions.heartbeatIntervalMs);

      // should not have sent another heartbeat
      expect(conn.send).toHaveBeenCalledTimes(1);
    });

    test('passive heartbeating echoes back acks', async () => {
      const sessionHandle = await createSessionConnected();
      const session: Session<MockConnection> = sessionHandle.session;
      const conn = session.conn;

      // wait for heartbeat timer
      vi.advanceTimersByTime(testingSessionOptions.heartbeatIntervalMs);
      expect(conn.send).toHaveBeenCalledTimes(0);

      // send a heartbeat
      conn.emitData(
        session.options.codec.toBuffer(
          session.constructMsg({
            streamId: 'heartbeat',
            controlFlags: ControlFlags.AckBit,
            payload: {
              type: 'ACK',
            } satisfies Static<typeof ControlMessageAckSchema>,
          }),
        ),
      );

      // make sure the session acks the heartbeat
      expect(conn.send).toHaveBeenCalledTimes(1);
    });

    test('does not dispatch acks', async () => {
      const sessionHandle = await createSessionConnected();
      const session: Session<MockConnection> = sessionHandle.session;
      const conn = session.conn;

      // send a heartbeat
      conn.emitData(
        session.options.codec.toBuffer(
          session.constructMsg({
            streamId: 'heartbeat',
            controlFlags: 0,
            payload: {
              type: 'ACK',
            } satisfies Static<typeof ControlMessageAckSchema>,
          }),
        ),
      );

      expect(conn.send).toHaveBeenCalledTimes(1);
      expect(sessionHandle.onMessage).not.toHaveBeenCalled();
    });
  });
});
