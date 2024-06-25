import { Logger, MessageMetadata } from '../../logging';
import { TelemetryInfo } from '../../tracing';
import {
  OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
  PartialTransportMessage,
  TransportClientId,
  TransportMessage,
} from '../message';
import { Connection, SessionOptions, unsafeId } from '../session';
import { Value } from '@sinclair/typebox/value';
import { SessionNoConnection } from './SessionNoConnection';
import { SessionConnecting } from './SessionConnecting';
import { SessionHandshaking } from './SessionHandshaking';
import { SessionConnected } from './SessionConnected';

export const enum SessionState {
  NoConnection = 'NoConnection',
  Connecting = 'Connecting',
  Handshaking = 'Handshaking',
  Connected = 'Connected',
  PendingIdentification = 'PendingIdentification',
}

// callback interfaces for various states
export interface SessionNoConnectionListeners {
  // timeout related
  onSessionGracePeriodElapsed: () => void;
}

export interface SessionConnectingListeners<ConnType extends Connection> {
  onConnectionEstablished: (conn: ConnType) => void;
  onConnectionFailed: (err: unknown) => void;

  // timeout related
  onConnectionTimeout: () => void;
}

export interface SessionHandshakingListeners {
  onConnectionErrored: (err: unknown) => void;
  onConnectionClosed: () => void;
  onHandshake: (msg: OpaqueTransportMessage) => void;

  // timeout related
  onHandshakeTimeout: () => void;
}

export interface SessionConnectedListeners {
  onConnectionErrored: (err: unknown) => void;
  onConnectionClosed: () => void;
  onMessage: (msg: OpaqueTransportMessage) => void;
}

export type Session<ConnType extends Connection> =
  | SessionNoConnection
  | SessionConnecting<ConnType>
  | SessionHandshaking<ConnType>
  | SessionConnected<ConnType>;

// close a pending connection if it resolves, ignore errors if the promise
// ends up rejected anyways
export function bestEffortClose<ConnType extends Connection>(
  prom: Promise<ConnType>,
) {
  void prom
    .then((conn) => conn.close())
    .catch(() => {
      // ignore errors
    });
}

export const ERR_CONSUMED = `session state has been consumed and is no longer valid`;

abstract class StateMachineState {
  abstract readonly state: SessionState;

  // whether this state has been consumed
  // and we've moved on to another state
  _isConsumed: boolean;

  // called when we're transitioning to another state
  abstract _onStateExit(): void;

  // called when we exit the state machine entirely
  abstract _onClose(): void;

  close(): void {
    this._onClose();
  }

  constructor() {
    this._isConsumed = false;

    // proxy should check if the state has been consumed
    return new Proxy(this, {
      get(target, prop) {
        // always allow access to _isConsumed
        if (prop === '_isConsumed') {
          return target._isConsumed;
        }

        // modify _onStateExit
        if (prop === '_onStateExit') {
          return () => {
            target._isConsumed = true;
            target._onStateExit();
          };
        }

        // modify _onClose
        if (prop === '_onClose') {
          return () => {
            target._onStateExit();
            target._onClose();
          };
        }

        if (target._isConsumed) {
          throw new Error(
            `${ERR_CONSUMED}: getting ${prop.toString()} on consumed state`,
          );
        }

        return Reflect.get(target, prop);
      },
      set(target, prop, value) {
        if (target._isConsumed) {
          throw new Error(
            `${ERR_CONSUMED}: setting ${prop.toString()} on consumed state`,
          );
        }

        return Reflect.set(target, prop, value);
      },
    });
  }
}

// all session states have a from and options
export abstract class CommonSession extends StateMachineState {
  readonly from: TransportClientId;
  readonly options: SessionOptions;

  log?: Logger;
  abstract get loggingMetadata(): MessageMetadata;

  constructor(from: TransportClientId, options: SessionOptions) {
    super();
    this.from = from;
    this.options = options;
  }

  parseMsg(msg: Uint8Array): OpaqueTransportMessage | null {
    const parsedMsg = this.options.codec.fromBuffer(msg);

    if (parsedMsg === null) {
      const decodedBuffer = new TextDecoder().decode(Buffer.from(msg));
      this.log?.error(
        `received malformed msg: ${decodedBuffer}`,
        this.loggingMetadata,
      );
      return null;
    }

    if (!Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
      this.log?.error(`received invalid msg: ${JSON.stringify(parsedMsg)}`, {
        ...this.loggingMetadata,
        validationErrors: [
          ...Value.Errors(OpaqueTransportMessageSchema, parsedMsg),
        ],
      });

      return null;
    }

    return parsedMsg;
  }
}

export type InheritedProperties = Pick<
  IdentifiedSession,
  'id' | 'from' | 'to' | 'seq' | 'ack' | 'sendBuffer' | 'telemetry' | 'options'
>;

// all sessions where we know the other side's client id
export abstract class IdentifiedSession extends CommonSession {
  readonly id: string;
  readonly telemetry: TelemetryInfo;
  readonly to: TransportClientId;

  seq: number;
  ack: number;
  sendBuffer: Array<OpaqueTransportMessage>;

  constructor(
    id: string,
    from: TransportClientId,
    to: TransportClientId,
    seq: number,
    ack: number,
    sendBuffer: Array<OpaqueTransportMessage>,
    telemetry: TelemetryInfo,
    options: SessionOptions,
  ) {
    super(from, options);
    this.id = id;
    this.to = to;
    this.seq = seq;
    this.ack = ack;
    this.sendBuffer = sendBuffer;
    this.telemetry = telemetry;
  }

  get loggingMetadata(): MessageMetadata {
    const spanContext = this.telemetry.span.spanContext();

    return {
      clientId: this.from,
      connectedTo: this.to,
      sessionId: this.id,
      telemetry: {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      },
    };
  }

  constructMsg<Payload>(
    partialMsg: PartialTransportMessage<Payload>,
  ): TransportMessage<Payload> {
    const msg = {
      ...partialMsg,
      id: unsafeId(),
      to: this.to,
      from: this.from,
      seq: this.seq,
      ack: this.ack,
    };

    this.seq++;
    return msg;
  }

  send(msg: PartialTransportMessage): string {
    const constructedMsg = this.constructMsg(msg);
    this.sendBuffer.push(constructedMsg);
    return constructedMsg.id;
  }

  _onStateExit(): void {
    // noop
  }

  _onClose(): void {
    // zero out the buffer
    this.sendBuffer.length = 0;
  }
}
