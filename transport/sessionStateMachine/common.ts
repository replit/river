import { Logger, MessageMetadata } from '../../logging';
import { TelemetryInfo } from '../../tracing';
import {
  OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
  PartialTransportMessage,
  TransportClientId,
  TransportMessage,
} from '../message';
import { Value } from '@sinclair/typebox/value';
import { SessionNoConnection } from './SessionNoConnection';
import { SessionConnecting } from './SessionConnecting';
import { SessionHandshaking } from './SessionHandshaking';
import { SessionConnected } from './SessionConnected';
import { Codec } from '../../codec';
import { Connection } from '../connection';
import { generateId } from '../id';

export const enum SessionState {
  NoConnection = 'NoConnection',
  Connecting = 'Connecting',
  Handshaking = 'Handshaking',
  Connected = 'Connected',
  PendingIdentification = 'PendingIdentification',
}

export type Session<ConnType extends Connection> =
  | SessionNoConnection
  | SessionConnecting<ConnType>
  | SessionHandshaking<ConnType>
  | SessionConnected<ConnType>;

export const ERR_CONSUMED = `session state has been consumed and is no longer valid`;

abstract class StateMachineState {
  abstract readonly state: SessionState;

  /*
   * Whether this state has been consumed
   * and we've moved on to another state
   */
  _isConsumed: boolean;

  // called when we're transitioning to another state
  // note that this is internal and should not be called directly
  // by consumers, the proxy will call this when the state is consumed
  // and we're transitioning to another state
  abstract _handleStateExit(): void;

  // called when we exit the state machine entirely
  // note that this is internal and should not be called directly
  // by consumers, the proxy will call this when .close is closed
  abstract _handleClose(): void;

  close(): void {
    this._handleClose();
  }

  constructor() {
    this._isConsumed = false;

    // proxy helps us prevent access to properties after the state has been consumed
    // e.g. if we hold a reference to a state and try to access it after it's been consumed
    // we intercept the access and throw an error to help catch bugs
    return new Proxy(this, {
      get(target, prop) {
        // always allow access to _isConsumed, id, and state
        if (prop === '_isConsumed' || prop === 'id' || prop === 'state') {
          return Reflect.get(target, prop);
        }

        // modify _handleStateExit
        if (prop === '_handleStateExit') {
          return () => {
            target._isConsumed = true;
            target._handleStateExit();
          };
        }

        // modify _handleClose
        if (prop === '_handleClose') {
          return () => {
            target._handleStateExit();
            target._handleClose();
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

export interface SessionOptions {
  /**
   * Frequency at which to send heartbeat acknowledgements
   */
  heartbeatIntervalMs: number;
  /**
   * Number of elapsed heartbeats without a response message before we consider
   * the connection dead.
   */
  heartbeatsUntilDead: number;
  /**
   * Duration to wait between connection disconnect and actual session disconnect
   */
  sessionDisconnectGraceMs: number;
  /**
   * Connection timeout in milliseconds
   */
  connectionTimeoutMs: number;
  /**
   * Handshake timeout in milliseconds
   */
  handshakeTimeoutMs: number;
  /**
   * The codec to use for encoding/decoding messages over the wire
   */
  codec: Codec;
}

// all session states have a from and options
export abstract class CommonSession extends StateMachineState {
  readonly from: TransportClientId;
  readonly options: SessionOptions;

  log?: Logger;
  abstract get loggingMetadata(): MessageMetadata;

  constructor(
    from: TransportClientId,
    options: SessionOptions,
    log: Logger | undefined,
  ) {
    super();
    this.from = from;
    this.options = options;
    this.log = log;
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

  /**
   * Index of the message we will send next (excluding handshake)
   */
  seq: number;

  /**
   * Number of unique messages we've received this session (excluding handshake)
   */
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
    log: Logger | undefined,
  ) {
    super(from, options, log);
    this.id = id;
    this.to = to;
    this.seq = seq;
    this.ack = ack;
    this.sendBuffer = sendBuffer;
    this.telemetry = telemetry;
    this.log = log;
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
      id: generateId(),
      to: this.to,
      from: this.from,
      seq: this.seq,
      ack: this.ack,
    };

    this.seq++;
    return msg;
  }

  nextSeq(): number {
    return this.sendBuffer.length > 0 ? this.sendBuffer[0].seq : this.seq;
  }

  send(msg: PartialTransportMessage): string {
    const constructedMsg = this.constructMsg(msg);
    this.sendBuffer.push(constructedMsg);
    return constructedMsg.id;
  }

  _handleStateExit(): void {
    // noop
  }

  _handleClose(): void {
    // zero out the buffer
    this.sendBuffer.length = 0;
    this.telemetry.span.end();
  }
}
