import { describe, expect, test, vi } from 'vitest';
import {
  Session,
  SessionPendingIdentification,
  SessionState,
  SessionStateMachine,
} from './index';
import {
  payloadToTransportMessage,
  testingSessionOptions,
} from '../../util/testHelpers';
import { Connection } from '../session';
import { waitFor } from '../../__tests__/fixtures/cleanup';

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
  dataListeners = new Set<(msg: Uint8Array) => void>();
  closeListeners = new Set<() => void>();
  errorListeners = new Set<(err: Error) => void>();

  addDataListener(cb: (msg: Uint8Array) => void): void {
    this.dataListeners.add(cb);
  }

  removeDataListener(cb: (msg: Uint8Array) => void): void {
    this.dataListeners.delete(cb);
  }

  addCloseListener(cb: () => void): void {
    this.closeListeners.add(cb);
  }

  removeCloseListener(cb: () => void): void {
    this.closeListeners.delete(cb);
  }

  addErrorListener(cb: (err: Error) => void): void {
    this.errorListeners.add(cb);
  }

  removeErrorListener(cb: (err: Error) => void): void {
    this.errorListeners.delete(cb);
  }

  send(_msg: Uint8Array): boolean {
    return true;
  }

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

describe('session state machine', () => {
  const createSessionNoConnection = () => {
    const session = SessionStateMachine.entrypoints.NoConnection(
      'to',
      'from',
      testingSessionOptions,
    );

    return { session };
  };

  const createSessionConnecting = async () => {
    let session: Session<MockConnection> = createSessionNoConnection().session;
    const { pendingConn, connect, error } = getPendingMockConnection();
    const listeners = {
      onConnectionEstablished: vi.fn(),
      onConnectionFailed: vi.fn(),
    };

    session = SessionStateMachine.transition.NoConnectionToConnecting(
      session,
      pendingConn,
      listeners,
    );

    return { session, connect, error, ...listeners };
  };

  const createSessionHandshaking = async () => {
    const sessionHandle = await createSessionConnecting();
    let session: Session<MockConnection> = sessionHandle.session;
    const { connect } = sessionHandle;

    connect();
    const conn = await session.connPromise;
    const listeners = {
      onHandshake: vi.fn(),
      onConnectionClosed: vi.fn(),
      onConnectionErrored: vi.fn(),
    };

    session = SessionStateMachine.transition.ConnectingToHandshaking(
      session,
      conn,
      listeners,
    );

    return { session, ...listeners };
  };

  const createSessionConnected = async () => {
    const sessionHandle = await createSessionHandshaking();
    let session: Session<MockConnection> = sessionHandle.session;
    const listeners = {
      onMessage: vi.fn(),
      onConnectionClosed: vi.fn(),
      onConnectionErrored: vi.fn(),
    };

    session = SessionStateMachine.transition.HandshakingToConnected(
      session,
      listeners,
    );

    return { session, ...listeners };
  };

  const createSessionPendingIdentification = async () => {
    const conn = new MockConnection();
    const listeners = {
      onHandshake: vi.fn(),
      onConnectionClosed: vi.fn(),
      onConnectionErrored: vi.fn(),
    };

    const session = SessionStateMachine.entrypoints.PendingIdentification(
      'from',
      conn,
      listeners,
      testingSessionOptions,
    );

    return { session, ...listeners };
  };

  describe('initial state', () => {
    test('no connection', () => {
      const { session } = createSessionNoConnection();
      expect(session.state).toBe(SessionState.NoConnection);
    });

    test('connecting', async () => {
      const { session } = await createSessionConnecting();
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
      const { session } = await createSessionPendingIdentification();
      expect(session.state).toBe(SessionState.PendingIdentification);
    });
  });

  describe('state transitions', () => {
    test('no connection -> connecting', async () => {
      const sessionHandle = createSessionNoConnection();
      let session: Session<MockConnection> = sessionHandle.session;
      expect(session.state).toBe(SessionState.NoConnection);
      const sessionStateToBePersisted = persistedSessionState(session);

      const { pendingConn } = getPendingMockConnection();
      const listeners = {
        onConnectionEstablished: vi.fn(),
        onConnectionFailed: vi.fn(),
      };
      session = SessionStateMachine.transition.NoConnectionToConnecting(
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
      const sessionHandle = await createSessionConnecting();
      let session: Session<MockConnection> = sessionHandle.session;
      const { connect } = sessionHandle;
      const sessionStateToBePersisted = persistedSessionState(session);

      connect();
      const conn = await session.connPromise;
      const listeners = {
        onHandshake: vi.fn(),
        onConnectionClosed: vi.fn(),
        onConnectionErrored: vi.fn(),
      };
      session = SessionStateMachine.transition.ConnectingToHandshaking(
        session,
        conn,
        listeners,
      );

      expect(session.state).toBe(SessionState.Handshaking);

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );

      // check handlers on the connection
      expect(conn.dataListeners.size).toBe(1);
      expect(conn.closeListeners.size).toBe(1);
      expect(conn.errorListeners.size).toBe(1);
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

      const listeners = {
        onMessage: vi.fn(),
        onConnectionClosed: vi.fn(),
        onConnectionErrored: vi.fn(),
      };
      session = SessionStateMachine.transition.HandshakingToConnected(
        session,
        listeners,
      );

      expect(session.state).toBe(SessionState.Connected);

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
    });

    test('pending -> connected', async () => {
      const sessionHandle = await createSessionPendingIdentification();
      let session:
        | Session<MockConnection>
        | SessionPendingIdentification<MockConnection> = sessionHandle.session;

      const oldListeners = {
        onHandshake: [...session.conn.dataListeners],
        onConnectionClosed: [...session.conn.closeListeners],
        onConnectionErrored: [...session.conn.errorListeners],
      };

      const listeners = {
        onMessage: vi.fn(),
        onConnectionClosed: vi.fn(),
        onConnectionErrored: vi.fn(),
      };
      session = SessionStateMachine.transition.PendingIdentificationToConnected(
        session,
        'clientSessionId',
        'to',
        listeners,
      );

      expect(session.state).toBe(SessionState.Connected);
      expect(session.id).toBe('clientSessionId');
      expect(session.to).toBe('to');

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
    });

    test('connecting (conn failed) -> no connection', async () => {
      const sessionHandle = await createSessionConnecting();
      let session: Session<MockConnection> = sessionHandle.session;
      const connPromise = session.connPromise;
      const { error } = sessionHandle;

      const sessionStateToBePersisted = persistedSessionState(session);
      error(new Error('test error'));

      session =
        SessionStateMachine.transition.ConnectingToNoConnection(session);

      expect(session.state).toBe(SessionState.NoConnection);
      await expect(connPromise).rejects.toThrowError('test error');

      // make sure the persisted state is the same
      expect(persistedSessionState(session)).toStrictEqual(
        sessionStateToBePersisted,
      );
    });

    test('connecting (conn ok) -> no connection', async () => {
      const sessionHandle = await createSessionConnecting();
      let session: Session<MockConnection> = sessionHandle.session;
      const connPromise = session.connPromise;
      const { connect } = sessionHandle;

      const sessionStateToBePersisted = persistedSessionState(session);
      connect();

      session =
        SessionStateMachine.transition.ConnectingToNoConnection(session);

      expect(session.state).toBe(SessionState.NoConnection);
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

      const sessionStateToBePersisted = persistedSessionState(session);
      session =
        SessionStateMachine.transition.HandshakingToNoConnection(session);

      expect(session.state).toBe(SessionState.NoConnection);
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

      const sessionStateToBePersisted = persistedSessionState(session);
      session = SessionStateMachine.transition.ConnectedToNoConnection(session);

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
        {
          onConnectionEstablished: vi.fn(),
          onConnectionFailed: vi.fn(),
        },
      );

      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('connecting -> handshaking', async () => {
      const sessionHandle = await createSessionConnecting();
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
        {
          onHandshake: vi.fn(),
          onConnectionClosed: vi.fn(),
          onConnectionErrored: vi.fn(),
        },
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

      session = SessionStateMachine.transition.HandshakingToConnected(session, {
        onMessage: vi.fn(),
        onConnectionClosed: vi.fn(),
        onConnectionErrored: vi.fn(),
      });

      expect(sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });

    test('connecting -> no connection', async () => {
      const sessionHandle = await createSessionConnecting();
      let session: Session<MockConnection> = sessionHandle.session;
      session.send(payloadToTransportMessage('hello'));
      session.send(payloadToTransportMessage('world'));
      expect(session.sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);

      session =
        SessionStateMachine.transition.ConnectingToNoConnection(session);

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

      session =
        SessionStateMachine.transition.HandshakingToNoConnection(session);

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

      session = SessionStateMachine.transition.ConnectedToNoConnection(session);

      expect(sendBuffer.length).toBe(2);
      expect(session.seq).toBe(2);
      expect(session.ack).toBe(0);
    });
  });

  describe('stale handles post-transition', () => {
    test.todo('no connection -> connecting: stale handle', async () => {});
    test.todo('connecting -> handshaking: stale handle', async () => {});
    test.todo('handshaking -> connected: stale handle', async () => {});
    test.todo('pending -> connected: stale handle', async () => {});
    test.todo('connecting -> no connection: stale handle', async () => {});
    test.todo('handshaking -> no connection: stale handle', async () => {});
    test.todo('connected -> no connection: stale handle', async () => {});
  });

  describe('close cleanup', () => {
    test.todo('no connection', async () => {});
    test.todo('connecting', async () => {});
    test.todo('handshaking', async () => {});
    test.todo('connected', async () => {});
    test.todo('pending identification', async () => {});
  });

  describe('event listeners', () => {
    test('connecting event listeners: connectionEstablished', async () => {
      const sessionHandle = await createSessionConnecting();
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
      const sessionHandle = await createSessionConnecting();
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

    test.todo('handshaking event listeners: connectionErrored', async () => {});
    test.todo('handshaking event listeners: connectionClosed', async () => {});
    test.todo('handshaking event listeners: onHandshakeData', async () => {});
    test.todo(
      'pending identification event listeners: connectionErrored',
      async () => {},
    );
    test.todo(
      'pending identification event listeners: connectionClosed',
      async () => {},
    );
    test.todo(
      'pending identification event listeners: onHandshakeData',
      async () => {},
    );
    test.todo('connected event listeners: connectionErrored', async () => {});
    test.todo('connected event listeners: connectionClosed', async () => {});
    test.todo('connected event listeners: onMessageData', async () => {});
  });
});
