import { describe, expect, test, vi } from 'vitest';
import {
  payloadToTransportMessage,
  testingSessionOptions,
} from '../../testUtil';
import { waitFor } from '../../__tests__/fixtures/cleanup';
import {
  ControlFlags,
  ControlMessageAckSchema,
  currentProtocolVersion,
  handshakeRequestMessage,
} from '../message';
import { ERR_CONSUMED, IdentifiedSession, SessionState } from './common';
import { Static } from '@sinclair/typebox';
import {
  SessionHandshaking,
  SessionHandshakingListeners,
} from './SessionHandshaking';
import {
  SessionConnected,
  SessionConnectedListeners,
} from './SessionConnected';
import {
  SessionConnecting,
  SessionConnectingListeners,
} from './SessionConnecting';
import {
  SessionNoConnection,
  SessionNoConnectionListeners,
} from './SessionNoConnection';
import { SessionStateGraph } from './transitions';
import { SessionWaitingForHandshake } from './SessionWaitingForHandshake';
import { Connection } from '../connection';
import {
  SessionBackingOff,
  SessionBackingOffListeners,
} from './SessionBackingOff';

function persistedSessionState(session: IdentifiedSession) {
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

function createSessionBackingOffListeners(): SessionBackingOffListeners {
  return {
    onBackoffFinished: vi.fn(),
    onSessionGracePeriodElapsed: vi.fn(),
  };
}

function createSessionConnectingListeners(): SessionConnectingListeners {
  return {
    onConnectionEstablished: vi.fn(),
    onConnectionFailed: vi.fn(),
    onConnectionTimeout: vi.fn(),
    onSessionGracePeriodElapsed: vi.fn(),
  };
}

function createSessionHandshakingListeners(): SessionHandshakingListeners {
  return {
    onHandshake: vi.fn(),
    onInvalidHandshake: vi.fn(),
    onConnectionClosed: vi.fn(),
    onConnectionErrored: vi.fn(),
    onHandshakeTimeout: vi.fn(),
    onSessionGracePeriodElapsed: vi.fn(),
  };
}

function createSessionConnectedListeners(): SessionConnectedListeners {
  return {
    onMessage: vi.fn(),
    onConnectionClosed: vi.fn(),
    onConnectionErrored: vi.fn(),
    onInvalidMessage: vi.fn(),
  };
}

function createSessionNoConnection() {
  const listeners = createSessionNoConnectionListeners();
  const session = SessionStateGraph.entrypoints.NoConnection(
    'to',
    'from',
    listeners,
    testingSessionOptions,
    currentProtocolVersion,
  );

  return { session, ...listeners };
}

function createSessionBackingOff(backoffMs = 0) {
  let session: SessionNoConnection | SessionBackingOff =
    createSessionNoConnection().session;

  const listeners = createSessionBackingOffListeners();
  session = SessionStateGraph.transition.NoConnectionToBackingOff(
    session,
    backoffMs,
    listeners,
  );

  return { session, ...listeners };
}

function createSessionConnecting() {
  let session: SessionBackingOff | SessionConnecting<MockConnection> =
    createSessionBackingOff().session;
  const { pendingConn, connect, error } = getPendingMockConnection();
  const listeners = createSessionConnectingListeners();

  session = SessionStateGraph.transition.BackingOffToConnecting(
    session,
    pendingConn,
    listeners,
  );

  return { session, connect, error, ...listeners };
}

async function createSessionHandshaking() {
  const sessionHandle = createSessionConnecting();
  let session:
    | SessionConnecting<MockConnection>
    | SessionHandshaking<MockConnection> = sessionHandle.session;
  const { connect } = sessionHandle;

  connect();
  const conn = await session.connPromise;
  const listeners = createSessionHandshakingListeners();
  session = SessionStateGraph.transition.ConnectingToHandshaking(
    session,
    conn,
    listeners,
  );

  return { session, ...listeners };
}

async function createSessionConnected() {
  const sessionHandle = await createSessionHandshaking();
  let session:
    | SessionHandshaking<MockConnection>
    | SessionConnected<MockConnection> = sessionHandle.session;
  const listeners = createSessionConnectedListeners();

  session = SessionStateGraph.transition.HandshakingToConnected(
    session,
    listeners,
  );

  return { session, ...listeners };
}

function createSessionWaitingForHandshake() {
  const conn = new MockConnection();
  const listeners = createSessionHandshakingListeners();
  const session = SessionStateGraph.entrypoints.WaitingForHandshake(
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
      const { session } = createSessionWaitingForHandshake();
      expect(session.state).toBe(SessionState.WaitingForHandshake);
    });
  });

  describe('state transitions', () => {
    test('no connection -> backing off', async () => {
      const sessionHandle = createSessionNoConnection();
      let session: SessionNoConnection | SessionBackingOff =
        sessionHandle.session;
      expect(session.state).toBe(SessionState.NoConnection);
      const sessionStateToBePersisted = persistedSessionState(session);
      const onSessionGracePeriodElapsed =
        sessionHandle.onSessionGracePeriodElapsed;

      const backoffMs = 5000;
      const listeners = createSessionBackingOffListeners();
      session = SessionStateGraph.transition.NoConnectionToBackingOff(
        session,
        backoffMs,
        listeners,
      );

      expect(session.state).toBe(SessionState.BackingOff);
      expect(listeners.onBackoffFinished).not.toHaveBeenCalled();
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(testingSessionOptions.sessionDisconnectGraceMs);
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
    });

    test('backing off -> connecting', async () => {
      const sessionHandle = createSessionBackingOff();
      let session: SessionBackingOff | SessionConnecting<MockConnection> =
        sessionHandle.session;
      expect(session.state).toBe(SessionState.BackingOff);
      const sessionStateToBePersisted = persistedSessionState(session);

      const { pendingConn } = getPendingMockConnection();
      const listeners = createSessionConnectingListeners();
      session = SessionStateGraph.transition.BackingOffToConnecting(
        session,
        pendingConn,
        listeners,
      );

      expect(session.state).toBe(SessionState.Connecting);
      expect(listeners.onConnectionEstablished).not.toHaveBeenCalled();
      expect(listeners.onConnectionFailed).not.toHaveBeenCalled();

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );
    });

    test('connecting -> handshaking', async () => {
      const sessionHandle = createSessionConnecting();
      let session:
        | SessionConnecting<MockConnection>
        | SessionHandshaking<MockConnection> = sessionHandle.session;
      const { connect } = sessionHandle;
      const sessionStateToBePersisted = persistedSessionState(session);
      const onConnectionTimeout = sessionHandle.onConnectionTimeout;

      connect();
      const conn = await session.connPromise;
      const listeners = createSessionHandshakingListeners();
      session = SessionStateGraph.transition.ConnectingToHandshaking(
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
      expect(conn.dataListeners.length).toBe(1);
      expect(conn.closeListeners.length).toBe(1);
      expect(conn.errorListeners.length).toBe(1);

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(testingSessionOptions.connectionTimeoutMs);
      expect(onConnectionTimeout).not.toHaveBeenCalled();
    });

    test('handshaking -> connected', async () => {
      const sessionHandle = await createSessionHandshaking();
      let session:
        | SessionHandshaking<MockConnection>
        | SessionConnected<MockConnection> = sessionHandle.session;
      const oldListeners = {
        onHandshakeData: [...session.conn.dataListeners],
        onConnectionClosed: [...session.conn.closeListeners],
        onConnectionErrored: [...session.conn.errorListeners],
      };

      const sessionStateToBePersisted = persistedSessionState(session);
      const onHandshakeTimeout = sessionHandle.onHandshakeTimeout;

      const listeners = createSessionConnectedListeners();
      session = SessionStateGraph.transition.HandshakingToConnected(
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
      expect(conn.dataListeners.length).toBe(1);
      expect(conn.closeListeners.length).toBe(1);
      expect(conn.errorListeners.length).toBe(1);

      // make sure the old listeners are removed
      for (const listener of oldListeners.onHandshakeData) {
        expect(conn.dataListeners.includes(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionClosed) {
        expect(conn.closeListeners.includes(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionErrored) {
        expect(conn.errorListeners.includes(listener)).toBe(false);
      }

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(testingSessionOptions.handshakeTimeoutMs);
      expect(onHandshakeTimeout).not.toHaveBeenCalled();
    });

    test('waiting (no existing session) -> connected', async () => {
      const sessionHandle = createSessionWaitingForHandshake();
      let session:
        | SessionConnected<MockConnection>
        | SessionWaitingForHandshake<MockConnection> = sessionHandle.session;

      const oldListeners = {
        onHandshake: [...session.conn.dataListeners],
        onConnectionClosed: [...session.conn.closeListeners],
        onConnectionErrored: [...session.conn.errorListeners],
      };

      const onHandshakeTimeout = sessionHandle.onHandshakeTimeout;
      const listeners = createSessionConnectedListeners();
      session = SessionStateGraph.transition.WaitingForHandshakeToConnected(
        session,
        undefined,
        'clientSessionId',
        'to',
        undefined,
        listeners,
        currentProtocolVersion,
      );

      expect(session.state).toBe(SessionState.Connected);
      expect(session.id).toBe('clientSessionId');
      expect(session.to).toBe('to');
      expect(onHandshakeTimeout).not.toHaveBeenCalled();

      // check handlers on the connection
      const conn = session.conn;
      expect(conn.dataListeners.length).toBe(1);
      expect(conn.closeListeners.length).toBe(1);
      expect(conn.errorListeners.length).toBe(1);

      // make sure the old listeners are removed
      for (const listener of oldListeners.onHandshake) {
        expect(conn.dataListeners.includes(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionClosed) {
        expect(conn.closeListeners.includes(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionErrored) {
        expect(conn.errorListeners.includes(listener)).toBe(false);
      }

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(testingSessionOptions.handshakeTimeoutMs);
      expect(onHandshakeTimeout).not.toHaveBeenCalled();
    });

    test('waiting (existing session) -> connected', async () => {
      const oldSessionHandle = createSessionNoConnection();
      const oldSession:
        | SessionConnected<MockConnection>
        | SessionNoConnection
        | SessionWaitingForHandshake<MockConnection> = oldSessionHandle.session;
      oldSession.send(payloadToTransportMessage('hello'));
      oldSession.send(payloadToTransportMessage('world'));
      expect(oldSession.sendBuffer.length).toBe(2);
      expect(oldSession.seq).toBe(2);
      expect(oldSession.ack).toBe(0);

      const sessionHandle = createSessionWaitingForHandshake();
      let session:
        | SessionConnected<MockConnection>
        | SessionWaitingForHandshake<MockConnection> = sessionHandle.session;

      const listeners = createSessionConnectedListeners();
      session = SessionStateGraph.transition.WaitingForHandshakeToConnected(
        session,
        oldSession,
        'clientSessionId',
        'to',
        undefined,
        listeners,
        currentProtocolVersion,
      );

      session.send(payloadToTransportMessage('foo'));
      expect(session.sendBuffer.length).toBe(3);
      expect(session.seq).toBe(3);
      expect(session.ack).toBe(0);
      expect(oldSession._isConsumed).toBe(true);
      expect(session.conn.send).toHaveBeenCalledTimes(3);
      expect(session.conn.status).toBe('open');
    });

    test('backing off -> no connection', async () => {
      const backoffMs = 5000;
      const sessionHandle = createSessionBackingOff(backoffMs);
      let session: SessionBackingOff | SessionNoConnection =
        sessionHandle.session;
      const sessionStateToBePersisted = persistedSessionState(session);
      const onBackoffFinished = sessionHandle.onBackoffFinished;

      const listeners = createSessionNoConnectionListeners();
      session = SessionStateGraph.transition.BackingOffToNoConnection(
        session,
        listeners,
      );

      expect(session.state).toBe(SessionState.NoConnection);
      expect(onBackoffFinished).not.toHaveBeenCalled();

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(backoffMs);
      expect(onBackoffFinished).not.toHaveBeenCalled();
    });

    test('connecting (conn failed) -> no connection', async () => {
      const sessionHandle = createSessionConnecting();
      let session: SessionConnecting<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      const connPromise = session.connPromise;
      const { error } = sessionHandle;

      const onConnectionTimeout = sessionHandle.onConnectionTimeout;
      const sessionStateToBePersisted = persistedSessionState(session);
      error(new Error('test error'));

      const listeners = createSessionNoConnectionListeners();
      session = SessionStateGraph.transition.ConnectingToNoConnection(
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
      let session: SessionConnecting<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      const connPromise = session.connPromise;
      const { connect } = sessionHandle;

      const onConnectionTimeout = sessionHandle.onConnectionTimeout;
      const sessionStateToBePersisted = persistedSessionState(session);
      connect();

      const listeners = createSessionNoConnectionListeners();
      session = SessionStateGraph.transition.ConnectingToNoConnection(
        session,
        listeners,
      );

      expect(session.state).toBe(SessionState.NoConnection);
      expect(onConnectionTimeout).not.toHaveBeenCalled();
      const conn = await connPromise;
      expect(conn.status).toBe('closed');

      // should not have any listeners
      expect(conn.dataListeners.length).toBe(0);
      expect(conn.closeListeners.length).toBe(0);
      expect(conn.errorListeners.length).toBe(0);

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
      let session: SessionHandshaking<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      const conn = session.conn;
      const oldListeners = {
        onHandshakeData: [...conn.dataListeners],
        onConnectionClosed: [...conn.closeListeners],
        onConnectionErrored: [...conn.errorListeners],
      };

      const onHandshakeTimeout = sessionHandle.onHandshakeTimeout;
      const listeners = createSessionNoConnectionListeners();
      const sessionStateToBePersisted = persistedSessionState(session);
      session = SessionStateGraph.transition.HandshakingToNoConnection(
        session,
        listeners,
      );

      expect(session.state).toBe(SessionState.NoConnection);
      expect(onHandshakeTimeout).not.toHaveBeenCalled();
      expect(conn.status).toBe('closed');

      // check handlers on the connection
      expect(conn.dataListeners.length).toBe(0);
      expect(conn.closeListeners.length).toBe(0);
      expect(conn.errorListeners.length).toBe(0);

      // make sure the old listeners are removed
      for (const listener of oldListeners.onHandshakeData) {
        expect(conn.dataListeners.includes(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionClosed) {
        expect(conn.closeListeners.includes(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionErrored) {
        expect(conn.errorListeners.includes(listener)).toBe(false);
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
      let session: SessionConnected<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      const conn = session.conn;
      const oldListeners = {
        onMessageData: [...conn.dataListeners],
        onConnectionClosed: [...conn.closeListeners],
        onConnectionErrored: [...conn.errorListeners],
      };

      const listeners = createSessionNoConnectionListeners();
      const sessionStateToBePersisted = persistedSessionState(session);
      session = SessionStateGraph.transition.ConnectedToNoConnection(
        session,
        listeners,
      );

      expect(session.state).toBe(SessionState.NoConnection);
      expect(conn.status).toBe('closed');

      // check handlers on the connection
      expect(conn.dataListeners.length).toBe(0);
      expect(conn.closeListeners.length).toBe(0);
      expect(conn.errorListeners.length).toBe(0);

      // make sure the old listeners are removed
      for (const listener of oldListeners.onMessageData) {
        expect(conn.dataListeners.includes(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionClosed) {
        expect(conn.closeListeners.includes(listener)).toBe(false);
      }

      for (const listener of oldListeners.onConnectionErrored) {
        expect(conn.errorListeners.includes(listener)).toBe(false);
      }

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );
    });
  });

  describe('state transitions preserve buffer, seq, ack', () => {
    test('no connection -> backing off', async () => {
      const sessionHandle = createSessionNoConnection();
      let session: SessionNoConnection | SessionBackingOff =
        sessionHandle.session;
      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      session = SessionStateGraph.transition.NoConnectionToBackingOff(
        session,
        0,
        createSessionBackingOffListeners(),
      );

      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('backing off -> connecting', async () => {
      const sessionHandle = createSessionBackingOff();
      let session: SessionBackingOff | SessionConnecting<MockConnection> =
        sessionHandle.session;
      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      const { pendingConn } = getPendingMockConnection();
      session = SessionStateGraph.transition.BackingOffToConnecting(
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
      let session:
        | SessionConnecting<MockConnection>
        | SessionHandshaking<MockConnection> = sessionHandle.session;
      const { connect } = sessionHandle;
      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      connect();
      const conn = await session.connPromise;
      session = SessionStateGraph.transition.ConnectingToHandshaking(
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
      let session:
        | SessionHandshaking<MockConnection>
        | SessionConnected<MockConnection> = sessionHandle.session;
      const sendBuffer = session.sendBuffer;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      session = SessionStateGraph.transition.HandshakingToConnected(
        session,
        createSessionConnectedListeners(),
      );

      expect(sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('backing off -> no connection', async () => {
      const sessionHandle = createSessionBackingOff();
      let session: SessionBackingOff | SessionNoConnection =
        sessionHandle.session;
      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      session = SessionStateGraph.transition.BackingOffToNoConnection(
        session,
        createSessionNoConnectionListeners(),
      );

      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('connecting -> no connection', async () => {
      const sessionHandle = createSessionConnecting();
      let session: SessionConnecting<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      session = SessionStateGraph.transition.ConnectingToNoConnection(
        session,
        createSessionNoConnectionListeners(),
      );

      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('handshaking -> no connection', async () => {
      const sessionHandle = await createSessionHandshaking();
      let session: SessionHandshaking<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      const sendBuffer = session.sendBuffer;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      session = SessionStateGraph.transition.HandshakingToNoConnection(
        session,
        createSessionNoConnectionListeners(),
      );

      expect(sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('connected -> no connection', async () => {
      const sessionHandle = await createSessionConnected();
      let session: SessionConnected<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      const sendBuffer = session.sendBuffer;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      session = SessionStateGraph.transition.ConnectedToNoConnection(
        session,
        createSessionNoConnectionListeners(),
      );

      expect(sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });
  });

  describe('state transitions deal with session grace period appropriately', async () => {
    test('no connection -> backing off: partially consumed grace period', async () => {
      const sessionHandle = createSessionNoConnection();
      let session: SessionNoConnection | SessionBackingOff =
        sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;

      // consume half the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 2),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      const listeners = createSessionBackingOffListeners();
      session = SessionStateGraph.transition.NoConnectionToBackingOff(
        session,
        5000,
        listeners,
      );

      // use the rest of the grace period after the transition and expect it to be called
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 2),
      );

      // only the new listeners should have been called
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(listeners.onSessionGracePeriodElapsed).toHaveBeenCalled();
    });

    test('no connection -> backing off -> connecting: partially consumed grace period', async () => {
      const sessionHandle = createSessionNoConnection();
      let session:
        | SessionNoConnection
        | SessionBackingOff
        | SessionConnecting<MockConnection> = sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;

      // consume a third of the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 3),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      const backingOffListeners = createSessionBackingOffListeners();
      const { pendingConn } = getPendingMockConnection();
      session = SessionStateGraph.transition.NoConnectionToBackingOff(
        session,
        5000, // arbitrary backoff
        backingOffListeners,
      );

      // consume another third of the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 3),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(
        backingOffListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();

      const connectingListeners = createSessionConnectingListeners();
      session = SessionStateGraph.transition.BackingOffToConnecting(
        session,
        pendingConn,
        connectingListeners,
      );

      // use the rest of the grace period after the transition and expect it to be called
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 3),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(
        backingOffListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();
      expect(
        connectingListeners.onSessionGracePeriodElapsed,
      ).toHaveBeenCalled();
    });

    test('no connection -> backing off -> connecting -> handshaking: partially consumed grace period', async () => {
      const sessionHandle = createSessionNoConnection();
      let session:
        | SessionNoConnection
        | SessionBackingOff
        | SessionConnecting<MockConnection>
        | SessionHandshaking<MockConnection> = sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;

      // consume a quarter of the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 4),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      const backingOffListeners = createSessionBackingOffListeners();
      session = SessionStateGraph.transition.NoConnectionToBackingOff(
        session,
        5000, // arbitrary backoff
        backingOffListeners,
      );

      // consume another quarter of the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 4),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(
        backingOffListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();

      const { pendingConn, connect } = getPendingMockConnection();
      const connectingListeners = createSessionConnectingListeners();
      session = SessionStateGraph.transition.BackingOffToConnecting(
        session,
        pendingConn,
        connectingListeners,
      );

      // consume another quarter of the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 4),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(
        backingOffListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();
      expect(
        connectingListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();

      connect();
      const conn = await session.connPromise;
      const handshakingListeners = createSessionHandshakingListeners();
      session = SessionStateGraph.transition.ConnectingToHandshaking(
        session,
        conn,
        handshakingListeners,
      );

      // use the rest of the grace period after the transition and expect it to be called
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 4),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(
        backingOffListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();
      expect(
        connectingListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();
      expect(
        handshakingListeners.onSessionGracePeriodElapsed,
      ).toHaveBeenCalled();
    });

    test('no connection -> backing off -> connecting -> handshaking -> connected: partially consumed grace period', async () => {
      const sessionHandle = createSessionNoConnection();
      let session:
        | SessionNoConnection
        | SessionBackingOff
        | SessionConnecting<MockConnection>
        | SessionHandshaking<MockConnection>
        | SessionConnected<MockConnection> = sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;

      // consume a fifth of the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 5),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      const backingOffListeners = createSessionBackingOffListeners();
      session = SessionStateGraph.transition.NoConnectionToBackingOff(
        session,
        5000, // arbitrary backoff
        backingOffListeners,
      );

      // consume another fifth of the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 5),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(
        backingOffListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();

      const { pendingConn, connect } = getPendingMockConnection();
      const connectingListeners = createSessionConnectingListeners();
      session = SessionStateGraph.transition.BackingOffToConnecting(
        session,
        pendingConn,
        connectingListeners,
      );

      // consume another fifth of the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 5),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(
        backingOffListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();
      expect(
        connectingListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();

      connect();
      const conn = await session.connPromise;
      const handshakingListeners = createSessionHandshakingListeners();
      session = SessionStateGraph.transition.ConnectingToHandshaking(
        session,
        conn,
        handshakingListeners,
      );

      // consume another fifth of the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 5),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(
        backingOffListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();
      expect(
        connectingListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();
      expect(
        handshakingListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();

      // finally transition to connected
      const connectedListeners = createSessionConnectedListeners();
      session = SessionStateGraph.transition.HandshakingToConnected(
        session,
        connectedListeners,
      );

      // use the rest of the grace period after the transition, ensure nothing gets called still
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 5),
      );

      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(
        backingOffListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();
      expect(
        connectingListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();
      expect(
        handshakingListeners.onSessionGracePeriodElapsed,
      ).not.toHaveBeenCalled();
    });

    test('backing off -> no connection: partially consumed grace period', async () => {
      const sessionHandle = createSessionBackingOff();
      let session: SessionBackingOff | SessionNoConnection =
        sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;

      // consume half the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 2),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      const listeners = createSessionNoConnectionListeners();
      session = SessionStateGraph.transition.BackingOffToNoConnection(
        session,
        listeners,
      );

      // use the rest of the grace period after the transition and expect it to be called
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 2),
      );

      // only the new listeners should have been called
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(listeners.onSessionGracePeriodElapsed).toHaveBeenCalled();
    });

    test('connecting -> no connection: partially consumed grace period', async () => {
      const sessionHandle = createSessionConnecting();
      let session: SessionConnecting<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;

      // consume half of the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 2),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      const listeners = createSessionNoConnectionListeners();
      session = SessionStateGraph.transition.ConnectingToNoConnection(
        session,
        listeners,
      );

      // use the rest of the grace period after the transition and expect it to be called
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 2),
      );

      // only the new listeners should have been called
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(listeners.onSessionGracePeriodElapsed).toHaveBeenCalled();
    });

    test('handshaking -> no connection: partially consumed grace period', async () => {
      const sessionHandle = await createSessionHandshaking();
      let session: SessionHandshaking<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;

      // consume half the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 2),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      const listeners = createSessionNoConnectionListeners();
      session = SessionStateGraph.transition.HandshakingToNoConnection(
        session,
        listeners,
      );

      // use the rest of the grace period after the transition and expect it to be called
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 2),
      );

      // only the new listeners should have been called
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
      expect(listeners.onSessionGracePeriodElapsed).toHaveBeenCalled();
    });

    test('handshaking -> connected: connected should clear grace timer', async () => {
      const sessionHandle = await createSessionHandshaking();
      let session:
        | SessionHandshaking<MockConnection>
        | SessionConnected<MockConnection> = sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;

      // consume half the grace period before the transition
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 2),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      const listeners = createSessionConnectedListeners();
      session = SessionStateGraph.transition.HandshakingToConnected(
        session,
        listeners,
      );

      // advance time and make sure timer doesn't go off
      vi.advanceTimersByTime(
        Math.ceil(session.options.sessionDisconnectGraceMs / 2),
      );
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
    });
  });

  describe('stale handles post-transition', () => {
    test('no connection -> backing off: stale handle', async () => {
      const sessionHandle = createSessionNoConnection();
      const session: SessionNoConnection | SessionBackingOff =
        sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;

      const listeners = createSessionBackingOffListeners();
      SessionStateGraph.transition.NoConnectionToBackingOff(
        session,
        0,
        listeners,
      );

      // doing anything on the old session should throw
      expect(() => session.loggingMetadata).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();
    });

    test('backing off -> connecting: stale handle', async () => {
      const sessionHandle = createSessionBackingOff();
      const session: SessionBackingOff | SessionConnecting<MockConnection> =
        sessionHandle.session;
      const { pendingConn } = getPendingMockConnection();
      const listeners = createSessionConnectingListeners();
      SessionStateGraph.transition.BackingOffToConnecting(
        session,
        pendingConn,
        listeners,
      );

      // doing anything on the old session should throw
      expect(() => session.loggingMetadata).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });

    test('connecting -> handshaking: stale handle', async () => {
      const sessionHandle = createSessionConnecting();
      const session:
        | SessionConnecting<MockConnection>
        | SessionHandshaking<MockConnection> = sessionHandle.session;
      const { connect } = sessionHandle;

      connect();
      const conn = await session.connPromise;
      const listeners = createSessionHandshakingListeners();
      SessionStateGraph.transition.ConnectingToHandshaking(
        session,
        conn,
        listeners,
      );

      // doing anything on the old session should throw
      expect(() => session.loggingMetadata).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });

    test('handshaking -> connected: stale handle', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session:
        | SessionHandshaking<MockConnection>
        | SessionConnected<MockConnection> = sessionHandle.session;
      const listeners = createSessionConnectedListeners();
      SessionStateGraph.transition.HandshakingToConnected(session, listeners);

      // doing anything on the old session should throw
      expect(() => session.loggingMetadata).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });

    test('waiting -> connected: stale handle', async () => {
      const sessionHandle = createSessionWaitingForHandshake();
      const session:
        | SessionConnected<MockConnection>
        | SessionWaitingForHandshake<MockConnection> = sessionHandle.session;
      const listeners = createSessionConnectedListeners();
      SessionStateGraph.transition.WaitingForHandshakeToConnected(
        session,
        undefined,
        'clientSessionId',
        'to',
        undefined,
        listeners,
        currentProtocolVersion,
      );

      // doing anything on the old session should throw
      expect(() => session.conn).toThrowError(ERR_CONSUMED);
    });

    test('backing off -> no connection: stale handle', async () => {
      const sessionHandle = createSessionBackingOff();
      const session: SessionBackingOff | SessionNoConnection =
        sessionHandle.session;
      const listeners = createSessionNoConnectionListeners();
      SessionStateGraph.transition.BackingOffToNoConnection(session, listeners);

      // doing anything on the old session should throw
      expect(() => session.loggingMetadata).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });

    test('connecting -> no connection: stale handle', async () => {
      const sessionHandle = createSessionConnecting();
      const session: SessionConnecting<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      const listeners = createSessionNoConnectionListeners();
      SessionStateGraph.transition.ConnectingToNoConnection(session, listeners);

      // doing anything on the old session should throw
      expect(() => session.loggingMetadata).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });

    test('handshaking -> no connection: stale handle', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session: SessionHandshaking<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      const listeners = createSessionNoConnectionListeners();
      SessionStateGraph.transition.HandshakingToNoConnection(
        session,
        listeners,
      );

      // doing anything on the old session should throw
      expect(() => session.loggingMetadata).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });

    test('connected -> no connection: stale handle', async () => {
      const sessionHandle = await createSessionConnected();
      const session: SessionConnected<MockConnection> | SessionNoConnection =
        sessionHandle.session;
      const listeners = createSessionNoConnectionListeners();
      SessionStateGraph.transition.ConnectedToNoConnection(session, listeners);

      // doing anything on the old session should throw
      expect(() => session.loggingMetadata).toThrowError(ERR_CONSUMED);
      expect(() => {
        session.send(payloadToTransportMessage('hello'));
      }).toThrowError(ERR_CONSUMED);
    });
  });

  describe('close cleanup', () => {
    test('no connection', async () => {
      const sessionHandle = createSessionNoConnection();
      const session = sessionHandle.session;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      const sendBuffer = session.sendBuffer;
      expect(sendBuffer.length).toBe(2);
      session.close();
      expect(sendBuffer.length).toBe(0);
      expect(session._isConsumed).toBe(true);
    });

    test('backing off', async () => {
      const backoffMs = 500;
      const sessionHandle = createSessionBackingOff(backoffMs);
      const session = sessionHandle.session;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      const sendBuffer = session.sendBuffer;
      expect(sendBuffer.length).toBe(2);
      session.close();
      expect(sendBuffer.length).toBe(0);
      expect(session._isConsumed).toBe(true);
    });

    test('connecting', async () => {
      const sessionHandle = createSessionConnecting();
      const session = sessionHandle.session;
      const { connect } = sessionHandle;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      const conn = session.connPromise;
      const sendBuffer = session.sendBuffer;
      expect(sendBuffer.length).toBe(2);
      connect();
      session.close();
      expect(sendBuffer.length).toBe(0);
      expect((await conn).status).toBe('closed');
      expect(session._isConsumed).toBe(true);
    });

    test('connecting finish after close', async () => {
      const sessionHandle = createSessionConnecting();
      const session = sessionHandle.session;
      const { connect, onConnectionEstablished } = sessionHandle;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      const conn = session.connPromise;
      const sendBuffer = session.sendBuffer;
      expect(sendBuffer.length).toBe(2);
      session.close();
      connect();

      expect((await conn).status).toBe('closed');
      expect(onConnectionEstablished).not.toHaveBeenCalled();
    });

    test('handshaking', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session = sessionHandle.session;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      const conn = session.conn;
      const sendBuffer = session.sendBuffer;
      expect(sendBuffer.length).toBe(2);
      session.close();

      expect(sendBuffer.length).toBe(0);
      expect(conn.status).toBe('closed');
      expect(session._isConsumed).toBe(true);
    });

    test('connected', async () => {
      const sessionHandle = await createSessionConnected();
      const session = sessionHandle.session;

      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      const conn = session.conn;
      const sendBuffer = session.sendBuffer;
      expect(sendBuffer.length).toBe(2);
      session.close();

      expect(sendBuffer.length).toBe(0);
      expect(conn.status).toBe('closed');
      expect(session._isConsumed).toBe(true);
    });

    test('pending identification', async () => {
      const sessionHandle = createSessionWaitingForHandshake();
      const session = sessionHandle.session;

      const conn = session.conn;
      session.close();

      expect(conn.status).toBe('closed');
      expect(session._isConsumed).toBe(true);
    });
  });

  describe('event listeners', () => {
    test('no connection event listeners: onSessionGracePeriodElapsed', async () => {
      const sessionHandle = createSessionNoConnection();
      const session = sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;
      expect(session.state).toBe(SessionState.NoConnection);
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      vi.advanceTimersByTime(testingSessionOptions.sessionDisconnectGraceMs);

      expect(onSessionGracePeriodElapsed).toHaveBeenCalled();
    });

    test('backing off event listeners: onBackoffFinished', async () => {
      const backoffMs = 500;
      const sessionHandle = createSessionBackingOff(backoffMs);
      const session = sessionHandle.session;
      const { onBackoffFinished } = sessionHandle;
      expect(session.state).toBe(SessionState.BackingOff);
      expect(onBackoffFinished).not.toHaveBeenCalled();

      vi.advanceTimersByTime(backoffMs);
      expect(onBackoffFinished).toHaveBeenCalled();
    });

    test('backing off event listeners: onSessionGracePeriodElapsed', async () => {
      const backoffMs = 500;
      const sessionHandle = createSessionBackingOff(backoffMs);
      const session = sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;
      expect(session.state).toBe(SessionState.BackingOff);
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      vi.advanceTimersByTime(testingSessionOptions.sessionDisconnectGraceMs);
      expect(onSessionGracePeriodElapsed).toHaveBeenCalled;
    });

    test('connecting event listeners: connectionEstablished', async () => {
      const sessionHandle = createSessionConnecting();
      const session = sessionHandle.session;
      const {
        connect,
        onConnectionEstablished: connectionEstablished,
        onConnectionFailed: connectionFailed,
      } = sessionHandle;
      expect(session.state).toBe(SessionState.Connecting);
      expect(connectionEstablished).not.toHaveBeenCalled();
      expect(connectionFailed).not.toHaveBeenCalled();

      connect();

      // wait for one tick
      await new Promise((resolve) => setImmediate(resolve));
      expect(connectionEstablished).toHaveBeenCalled();
      expect(connectionEstablished).toHaveBeenCalledWith(
        await session.connPromise,
      );
      expect(connectionFailed).not.toHaveBeenCalled();

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.Connecting);
    });

    test('connecting event listeners: connectionFailed', async () => {
      const sessionHandle = createSessionConnecting();
      const session = sessionHandle.session;
      const { error, onConnectionEstablished, onConnectionFailed } =
        sessionHandle;
      expect(session.state).toBe(SessionState.Connecting);
      expect(onConnectionEstablished).not.toHaveBeenCalled();
      expect(onConnectionFailed).not.toHaveBeenCalled();

      error(new Error('test error'));

      await new Promise((resolve) => setImmediate(resolve));
      expect(onConnectionFailed).toHaveBeenCalled();
      expect(onConnectionFailed).toHaveBeenCalledWith(new Error('test error'));
      expect(onConnectionEstablished).not.toHaveBeenCalled();

      // should not have transitioned to the next state
      expect(session.state).toBe(SessionState.Connecting);
    });

    test('connecting event listeners: connectionTimeout', async () => {
      const sessionHandle = createSessionConnecting();
      const session = sessionHandle.session;
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

    test('connecting event listeners: sessionGracePeriodElapsed', async () => {
      const sessionHandle = createSessionConnecting();
      const session = sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;
      expect(session.state).toBe(SessionState.Connecting);
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      vi.advanceTimersByTime(testingSessionOptions.sessionDisconnectGraceMs);
      expect(onSessionGracePeriodElapsed).toHaveBeenCalled();
    });

    test('handshaking event listeners: connectionErrored', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session = sessionHandle.session;
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
      const session = sessionHandle.session;
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
      const session = sessionHandle.session;
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
              nextExpectedSeq: 0,
              nextSentSeq: 0,
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
      const session = sessionHandle.session;
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

    test('handshaking event listeners: sessionGracePeriodElapsed', async () => {
      const sessionHandle = await createSessionHandshaking();
      const session = sessionHandle.session;
      const { onSessionGracePeriodElapsed } = sessionHandle;
      expect(session.state).toBe(SessionState.Handshaking);
      expect(onSessionGracePeriodElapsed).not.toHaveBeenCalled();

      vi.advanceTimersByTime(testingSessionOptions.sessionDisconnectGraceMs);
      expect(onSessionGracePeriodElapsed).toHaveBeenCalled();
    });

    test('pending identification event listeners: connectionErrored', async () => {
      const sessionHandle = createSessionWaitingForHandshake();
      const session = sessionHandle.session;

      const conn = session.conn;
      const { onHandshake, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.WaitingForHandshake);
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
      expect(session.state).toBe(SessionState.WaitingForHandshake);
    });

    test('pending identification event listeners: connectionClosed', async () => {
      const sessionHandle = createSessionWaitingForHandshake();
      const session = sessionHandle.session;

      const conn = session.conn;
      const { onHandshake, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.WaitingForHandshake);
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
      expect(session.state).toBe(SessionState.WaitingForHandshake);
    });

    test('pending identification event listeners: onHandshakeData', async () => {
      const sessionHandle = createSessionWaitingForHandshake();
      const session = sessionHandle.session;

      const { onHandshake, onConnectionClosed, onConnectionErrored } =
        sessionHandle;
      expect(session.state).toBe(SessionState.WaitingForHandshake);
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
              nextExpectedSeq: 0,
              nextSentSeq: 0,
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
      expect(session.state).toBe(SessionState.WaitingForHandshake);
    });

    test('pending identification event listeners: handshakeTimeout', async () => {
      const sessionHandle = createSessionWaitingForHandshake();
      const session = sessionHandle.session;

      const {
        onHandshake,
        onConnectionClosed,
        onConnectionErrored,
        onHandshakeTimeout,
      } = sessionHandle;
      expect(session.state).toBe(SessionState.WaitingForHandshake);
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
      const session = sessionHandle.session;
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
      const session = sessionHandle.session;
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
      const session = sessionHandle.session;
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
      const session = sessionHandle.session;
      const conn = session.conn;

      // wait for heartbeat timer
      session.startActiveHeartbeat();
      vi.advanceTimersByTime(testingSessionOptions.heartbeatIntervalMs);

      // make sure conn has received the heartbeat
      expect(conn.send).toHaveBeenCalledTimes(1);

      // transition to no connection
      const listeners = createSessionNoConnectionListeners();
      SessionStateGraph.transition.ConnectedToNoConnection(session, listeners);

      // send another heartbeat
      vi.advanceTimersByTime(testingSessionOptions.heartbeatIntervalMs);

      // should not have sent another heartbeat
      expect(conn.send).toHaveBeenCalledTimes(1);
    });

    test('passive heartbeating echoes back acks', async () => {
      const sessionHandle = await createSessionConnected();
      const session = sessionHandle.session;
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
      const session = sessionHandle.session;
      const conn = session.conn;

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

      expect(sessionHandle.onMessage).not.toHaveBeenCalled();
    });
  });
});
