import { nanoid } from 'nanoid';
import { Logger, MessageMetadata } from '../../logging';
import { TelemetryInfo, createSessionTelemetryInfo } from '../../tracing';
import {
  OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
  PartialTransportMessage,
  TransportClientId,
  TransportMessage,
} from '../message';
import { Connection, SessionOptions, unsafeId } from '../session';
import { Value } from '@sinclair/typebox/value';

export const enum SessionState {
  NoConnection = 'NoConnection',
  Connecting = 'Connecting',
  Handshaking = 'Handshaking',
  Connected = 'Connected',
  PendingIdentification = 'PendingIdentification',
}

// callback interfaces for various states
export interface SessionConnectingListeners<ConnType extends Connection> {
  onConnectionEstablished: (conn: ConnType) => void;
  onConnectionFailed: (err: unknown) => void;
}

export interface SessionHandshakingListeners {
  onConnectionErrored: (err: unknown) => void;
  onConnectionClosed: () => void;
  onHandshake: (msg: OpaqueTransportMessage) => void;
}

export interface SessionConnectedListeners {
  onConnectionErrored: (err: unknown) => void;
  onConnectionClosed: () => void;
  onMessage: (msg: OpaqueTransportMessage) => void;
}

interface StateMachineStateConstructor {
  readonly state: SessionState;
}

interface StateMachineState {
  // whether this state has been consumed
  // and we've moved on to another state
  _isConsumed: boolean;

  // called when we're transitioning to another state
  _onStateExit(): void;

  // called when we exit the state machine entirely
  _onClose(): void;
}

type CommonSession = StateMachineStateConstructor &
  StateMachineState & {
    readonly from: TransportClientId;
    readonly options: SessionOptions;

    log?: Logger;
  };

type BareSession<T extends CommonSession> = Omit<T, keyof StateMachineState>;

export interface SessionPendingIdentification<ConnType extends Connection>
  extends CommonSession {
  readonly state: SessionState.PendingIdentification;
  conn: ConnType;
  listeners: SessionHandshakingListeners;
  sendHandshake(msg: TransportMessage): boolean;
}

// common session interface for all identified sessions
interface IdentifiedSession extends CommonSession {
  readonly id: string;
  readonly telemetry: TelemetryInfo;
  readonly to: TransportClientId;

  /**
   * Number of messages we've sent along this session (excluding handshake and acks)
   */
  seq: number;

  /**
   * Number of unique messages we've received this session (excluding handshake and acks)
   */
  ack: number;

  sendBuffer: Array<OpaqueTransportMessage>;
  send(msg: PartialTransportMessage): string;
}

export type Session<ConnType extends Connection> =
  | SessionNoConnection
  | SessionConnecting<ConnType>
  | SessionHandshaking<ConnType>
  | SessionConnected<ConnType>;

interface SessionNoConnection extends IdentifiedSession {
  readonly state: SessionState.NoConnection;
}

interface SessionConnecting<ConnType extends Connection>
  extends IdentifiedSession {
  readonly state: SessionState.Connecting;
  connPromise: Promise<ConnType>;
  listeners: SessionConnectingListeners<ConnType>;
}

interface SessionHandshaking<ConnType extends Connection>
  extends IdentifiedSession {
  readonly state: SessionState.Handshaking;
  conn: ConnType;
  listeners: SessionHandshakingListeners;
}

interface SessionConnected<ConnType extends Connection>
  extends IdentifiedSession {
  readonly state: SessionState.Connected;
  conn: ConnType;
  listeners: SessionConnectedListeners;
}

// common helpers on sessions
function constructMsg<Payload>(
  session: BareSession<IdentifiedSession>,
  partialMsg: PartialTransportMessage<Payload>,
): TransportMessage<Payload> {
  const msg = {
    ...partialMsg,
    id: unsafeId(),
    to: session.to,
    from: session.from,
    seq: session.seq,
    ack: session.ack,
  };

  session.seq++;
  return msg;
}

function loggingMetadata(
  session:
    | BareSession<Session<Connection>>
    | BareSession<SessionPendingIdentification<Connection>>,
): MessageMetadata {
  if (session.state === SessionState.PendingIdentification) {
    return {
      clientId: session.from,
      connId: session.conn.id,
    };
  }

  const spanContext = session.telemetry.span.spanContext();

  return {
    clientId: session.from,
    connectedTo: session.to,
    sessionId: session.id,
    telemetry: {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
    },
  };
}

function inheritSharedSession(session: BareSession<IdentifiedSession>) {
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

function parseMsg(
  session:
    | BareSession<Session<Connection>>
    | BareSession<SessionPendingIdentification<Connection>>,
  msg: Uint8Array,
) {
  const parsedMsg = session.options.codec.fromBuffer(msg);

  if (parsedMsg === null) {
    const decodedBuffer = new TextDecoder().decode(Buffer.from(msg));
    session.log?.error(
      `received malformed msg, killing conn: ${decodedBuffer}`,
      loggingMetadata(session),
    );
    return null;
  }

  if (!Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
    session.log?.error(`received invalid msg: ${JSON.stringify(parsedMsg)}`, {
      ...loggingMetadata(session),
      validationErrors: [
        ...Value.Errors(OpaqueTransportMessageSchema, parsedMsg),
      ],
    });
    return null;
  }

  return parsedMsg;
}

function updateBookkeeping(
  session: BareSession<Session<Connection>>,
  ack: number,
  seq: number,
) {
  if (seq + 1 < session.ack) {
    session.log?.error(`received stale seq ${seq} + 1 < ${session.ack}`, {
      ...loggingMetadata(session),
      tags: ['invariant-violation'],
    });
    return;
  }

  session.sendBuffer = session.sendBuffer.filter(
    (unacked) => unacked.seq >= ack,
  );
  session.ack = seq + 1;
}

// close a pending connection if it resolves, ignore errors if the promise
// ends up rejected anyways
function bestEffortClose<ConnType extends Connection>(prom: Promise<ConnType>) {
  void prom
    .then((conn) => conn.close())
    .catch(() => {
      // ignore errors
    });
}

// proxy should check if the state has been consumed
// and throw an error on accessing/mutating any of its properties if it has
const errMsg = 'session state has been consumed and is no longer valid';
function asStateMachineState<T>(
  state: T & {
    // setup
    setup(): {
      transitionCleanup(): void;
      closeCleanup(): void;
    };
  },
): StateMachineState & Omit<T, 'setup'> {
  const cleanup = state.setup();
  return new Proxy<StateMachineState & T>(
    {
      ...state,
      _isConsumed: false,
      _onStateExit() {
        this._isConsumed = true;
        cleanup.transitionCleanup();
      },
      _onClose() {
        this._onStateExit();
        cleanup.closeCleanup();
      },
    },
    {
      get(target, prop) {
        // always allow access to _isConsumed
        if (prop === '_isConsumed') {
          return target._isConsumed;
        }

        if (target._isConsumed) {
          throw new Error(
            `${errMsg}: getting ${prop.toString()} on consumed state`,
          );
        }

        return Reflect.get(target, prop);
      },
      set(target, prop, value) {
        if (target._isConsumed) {
          throw new Error(
            `${errMsg}: setting ${prop.toString()} on consumed state`,
          );
        }

        return Reflect.set(target, prop, value);
      },
    },
  );
}

/**
 *                   0. SessionNoConnection         ◄──┐
 *                   │  reconnect / connect attempt    │
 *                   ▼                                 │
 *                   1. SessionConnecting      ────────┤ connect failure
 *                   │  connect success                │
 *                   ▼                                 │ handshake failure
 *                   2. SessionHandshaking     ────────┤ connection drop
 * 4. PendingSession │  handshake success              │
 * │  server-side    ▼                                 │ connection drop
 * └───────────────► 3. SessionConnected   ────────────┘ heartbeat misses
 */
export const SessionStateMachine = {
  entrypoints: {
    NoConnection(
      to: TransportClientId,
      from: TransportClientId,
      options: SessionOptions,
    ): SessionNoConnection {
      const id = `session-${nanoid(12)}`;
      const telemetry = createSessionTelemetryInfo(id, to, from);
      const sendBuffer: Array<OpaqueTransportMessage> = [];

      return asStateMachineState({
        state: SessionState.NoConnection as const,
        id,
        from,
        to,
        seq: 0,
        ack: 0,
        options,
        telemetry,
        sendBuffer,
        send(msg: PartialTransportMessage): string {
          const constructedMsg = constructMsg(this, msg);
          sendBuffer.push(constructedMsg);
          return constructedMsg.id;
        },
        setup() {
          return {
            transitionCleanup: () => {
              // noop
            },
            closeCleanup: () => {
              sendBuffer.length = 0;
            },
          };
        },
      });
    },
    PendingIdentification<ConnType extends Connection>(
      from: TransportClientId,
      conn: ConnType,
      listeners: SessionHandshakingListeners,
      options: SessionOptions,
    ): SessionPendingIdentification<ConnType> {
      return asStateMachineState({
        state: SessionState.PendingIdentification as const,
        from,
        conn,
        options,
        listeners,
        sendHandshake(msg: TransportMessage): boolean {
          return conn.send(options.codec.toBuffer(msg));
        },
        setup() {
          const onHandshakeData = (msg: Uint8Array) => {
            const parsedMsg = parseMsg(this, msg);
            if (parsedMsg === null) return;

            this.listeners.onHandshake(parsedMsg);
          };

          conn.addDataListener(onHandshakeData);
          conn.addErrorListener(listeners.onConnectionErrored);
          conn.addCloseListener(listeners.onConnectionClosed);

          return {
            transitionCleanup: () => {
              conn.removeDataListener(onHandshakeData);
              conn.removeErrorListener(listeners.onConnectionErrored);
              conn.removeCloseListener(listeners.onConnectionClosed);
            },
            closeCleanup: () => {
              conn.close();
            },
          };
        },
      });
    },
  },
  transition: {
    // happy path transitions
    NoConnectionToConnecting<ConnType extends Connection>(
      oldSession: SessionNoConnection,
      connPromise: Promise<ConnType>,
      listeners: SessionConnectingListeners<ConnType>,
    ): SessionConnecting<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      const sendBuffer = oldSession.sendBuffer;
      oldSession._onStateExit();

      const newState = asStateMachineState({
        ...carriedState,
        state: SessionState.Connecting as const,
        sendBuffer,
        connPromise,
        listeners,
        send(msg: PartialTransportMessage): string {
          const constructedMsg = constructMsg(this, msg);
          this.sendBuffer.push(constructedMsg);
          return constructedMsg.id;
        },
        setup() {
          return {
            transitionCleanup: () => {
              // noop
            },
            closeCleanup: () => {
              sendBuffer.length = 0;
              bestEffortClose(connPromise);
            },
          };
        },
      });

      newState.connPromise.then(
        (conn) => {
          if (newState._isConsumed) return;
          listeners.onConnectionEstablished(conn);
        },
        (err) => {
          if (newState._isConsumed) return;
          listeners.onConnectionFailed(err);
        },
      );

      return newState;
    },
    ConnectingToHandshaking<ConnType extends Connection>(
      oldSession: SessionConnecting<ConnType>,
      conn: ConnType,
      listeners: SessionHandshakingListeners,
    ): SessionHandshaking<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      const sendBuffer = oldSession.sendBuffer;
      oldSession._onStateExit();

      return asStateMachineState({
        ...carriedState,
        state: SessionState.Handshaking as const,
        sendBuffer,
        conn,
        listeners,
        send(msg: PartialTransportMessage): string {
          const constructedMsg = constructMsg(this, msg);
          this.sendBuffer.push(constructedMsg);
          return constructedMsg.id;
        },
        setup() {
          const onHandshakeData = (msg: Uint8Array) => {
            const parsedMsg = parseMsg(this, msg);
            if (parsedMsg === null) return;

            updateBookkeeping(this, parsedMsg.ack, parsedMsg.seq);
            this.listeners.onHandshake(parsedMsg);
          };

          conn.addDataListener(onHandshakeData);
          conn.addErrorListener(listeners.onConnectionErrored);
          conn.addCloseListener(listeners.onConnectionClosed);

          return {
            transitionCleanup: () => {
              conn.removeDataListener(onHandshakeData);
              conn.removeErrorListener(listeners.onConnectionErrored);
              conn.removeCloseListener(listeners.onConnectionClosed);
            },
            closeCleanup: () => {
              sendBuffer.length = 0;
              conn.close();
            },
          };
        },
      });
    },
    HandshakingToConnected<ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
      listeners: SessionConnectedListeners,
    ): SessionConnected<ConnType> {
      const carriedState = inheritSharedSession(oldSession);
      const sendBuffer = oldSession.sendBuffer;
      const conn = oldSession.conn;
      oldSession._onStateExit();

      return asStateMachineState({
        ...carriedState,
        state: SessionState.Connected as const,
        sendBuffer,
        conn,
        listeners,
        send(msg: PartialTransportMessage): string {
          const constructedMsg = constructMsg(this, msg);
          this.conn.send(this.options.codec.toBuffer(constructedMsg));
          this.sendBuffer.push(constructedMsg);
          return constructedMsg.id;
        },
        setup() {
          const onMessageData = (msg: Uint8Array) => {
            const parsedMsg = parseMsg(this, msg);
            if (parsedMsg === null) return;

            updateBookkeeping(this, parsedMsg.ack, parsedMsg.seq);
            this.listeners.onMessage(parsedMsg);
          };

          conn.addDataListener(onMessageData);
          conn.addCloseListener(listeners.onConnectionClosed);
          conn.addErrorListener(listeners.onConnectionErrored);

          // send any buffered messages
          for (const msg of sendBuffer) {
            conn.send(carriedState.options.codec.toBuffer(msg));
          }

          return {
            transitionCleanup: () => {
              conn.removeDataListener(onMessageData);
              conn.removeCloseListener(listeners.onConnectionClosed);
              conn.removeErrorListener(listeners.onConnectionErrored);
            },
            closeCleanup: () => {
              sendBuffer.length = 0;
              conn.close();
            },
          };
        },
      });
    },
    PendingIdentificationToConnected<ConnType extends Connection>(
      oldSession: SessionPendingIdentification<ConnType>,
      sessionId: string,
      to: TransportClientId,
      listeners: SessionConnectedListeners,
    ): SessionConnected<ConnType> {
      const conn = oldSession.conn;
      const { from, options } = oldSession;
      oldSession._onStateExit();

      const sendBuffer: Array<OpaqueTransportMessage> = [];
      return asStateMachineState({
        state: SessionState.Connected as const,
        sendBuffer,
        id: sessionId,
        from,
        to,
        seq: 0,
        ack: 0,
        options,
        telemetry: createSessionTelemetryInfo(sessionId, to, from),
        conn,
        listeners,
        send(msg: PartialTransportMessage): string {
          const constructedMsg = constructMsg(this, msg);
          this.conn.send(this.options.codec.toBuffer(constructedMsg));
          sendBuffer.push(constructedMsg);
          return constructedMsg.id;
        },
        setup() {
          const onMessageData = (msg: Uint8Array) => {
            const parsedMsg = parseMsg(this, msg);
            if (parsedMsg === null) return;

            updateBookkeeping(this, parsedMsg.ack, parsedMsg.seq);
            this.listeners.onMessage(parsedMsg);
          };

          conn.addDataListener(onMessageData);
          conn.addCloseListener(listeners.onConnectionClosed);
          conn.addErrorListener(listeners.onConnectionErrored);

          return {
            transitionCleanup: () => {
              conn.removeDataListener(onMessageData);
              conn.removeCloseListener(listeners.onConnectionClosed);
              conn.removeErrorListener(listeners.onConnectionErrored);
            },
            closeCleanup: () => {
              conn.close();
            },
          };
        },
      });
    },
    // disconnect paths
    ConnectingToNoConnection<ConnType extends Connection>(
      oldSession: SessionConnecting<ConnType>,
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      const sendBuffer = oldSession.sendBuffer;
      bestEffortClose(oldSession.connPromise);
      oldSession._onStateExit();

      return asStateMachineState({
        ...carriedState,
        state: SessionState.NoConnection as const,
        sendBuffer,
        send(msg: PartialTransportMessage): string {
          const constructedMsg = constructMsg(this, msg);
          this.sendBuffer.push(constructedMsg);
          return constructedMsg.id;
        },
        setup() {
          return {
            transitionCleanup: () => {
              // noop
            },
            closeCleanup: () => {
              sendBuffer.length = 0;
            },
          };
        },
      });
    },
    HandshakingToNoConnection<ConnType extends Connection>(
      oldSession: SessionHandshaking<ConnType>,
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      const sendBuffer = oldSession.sendBuffer;
      oldSession.conn.close();
      oldSession._onStateExit();

      return asStateMachineState({
        ...carriedState,
        state: SessionState.NoConnection as const,
        sendBuffer,
        send(msg: PartialTransportMessage): string {
          const constructedMsg = constructMsg(this, msg);
          this.sendBuffer.push(constructedMsg);
          return constructedMsg.id;
        },
        setup() {
          return {
            transitionCleanup: () => {
              // noop
            },
            closeCleanup: () => {
              sendBuffer.length = 0;
            },
          };
        },
      });
    },
    ConnectedToNoConnection<ConnType extends Connection>(
      oldSession: SessionConnected<ConnType>,
    ): SessionNoConnection {
      const carriedState = inheritSharedSession(oldSession);
      oldSession.conn.close();
      oldSession._onStateExit();

      const sendBuffer = [];
      return asStateMachineState({
        ...carriedState,
        state: SessionState.NoConnection as const,
        sendBuffer: [],
        send(msg: PartialTransportMessage): string {
          const constructedMsg = constructMsg(this, msg);
          sendBuffer.push(constructedMsg);
          return constructedMsg.id;
        },
        setup() {
          return {
            transitionCleanup: () => {
              // noop
            },
            closeCleanup: () => {
              sendBuffer.length = 0;
            },
          };
        },
      });
    },
  },
} as const;
