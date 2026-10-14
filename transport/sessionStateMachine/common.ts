import { Logger, MessageMetadata } from '../../logging';
import { TelemetryInfo } from '../../tracing';
import {
  EncodedTransportMessage,
  PartialTransportMessage,
  ProtocolVersion,
  TransportClientId,
} from '../message';
import { Codec, CodecMessageAdapter } from '../../codec';
import { generateId } from '../id';
import { Tracer } from '@opentelemetry/api';
import { EncodeResult, SendResult } from '../results';
import { createPromiseWithResolvers, PromiseWithResolvers } from '../promises';

export const enum SessionState {
  NoConnection = 'NoConnection',
  BackingOff = 'BackingOff',
  Connecting = 'Connecting',
  Handshaking = 'Handshaking',
  Connected = 'Connected',
  WaitingForHandshake = 'WaitingForHandshake',
}

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

  /**
   * Cleanup this state machine state and mark it as consumed.
   * After calling close, it is an error to access any properties on the state.
   * You should never need to call this as a consumer.
   *
   * If you're looking to close the session from the client,
   * use `.hardDisconnect` on the client transport.
   */
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
            // target is the non-proxied object, we need to set _isConsumed again
            target._isConsumed = true;
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
   * Max duration that a session can be without a connection before we consider
   * it dead. This deadline is carried between states and is used to determine
   * when to consider the session a lost cause and delete it entirely.
   * Generally, this should be strictly greater than the sum of
   * {@link connectionTimeoutMs} and {@link handshakeTimeoutMs}.
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
   * Whether to enable transparent session reconnects
   */
  enableTransparentSessionReconnects: boolean;
  /**
   * Number of messages in the session's send buffer at or above which
   * {@link Writable.write} reports backpressure (returns false). This is
   * purely advisory: writes are never dropped or blocked regardless of
   * this value. Must be at least 1 — with a value of 0 the buffer can
   * never drain below the mark and waiters would only resolve on
   * session close.
   */
  sendBufferHighWaterMark: number;
  /**
   * Optional per-stream advisory watermark. When set, stream writers use
   * this limit instead of the session watermark. This is not a memory cap.
   */
  streamSendBufferHighWaterMark?: number;
  /**
   * Opt-in ACK batching for inbound non-ACK messages. Outbound messages
   * already carry an ACK and cancel any pending batch.
   */
  receiverAck?: { maxMessages: number; maxDelayMs: number };
  /**
   * The codec to use for encoding/decoding messages over the wire
   */
  codec: Codec;
}

// all session states have a from and options
export interface CommonSessionProps {
  from: TransportClientId;
  options: SessionOptions;
  codec: CodecMessageAdapter;
  tracer: Tracer;
  log: Logger | undefined;
}

export abstract class CommonSession extends StateMachineState {
  readonly from: TransportClientId;
  readonly options: SessionOptions;

  readonly codec: CodecMessageAdapter;
  tracer: Tracer;
  log?: Logger;
  abstract get loggingMetadata(): MessageMetadata;

  constructor({ from, options, log, tracer, codec }: CommonSessionProps) {
    super();
    this.from = from;
    this.options = options;
    this.log = log;
    this.tracer = tracer;
    this.codec = codec;
  }
}

export type InheritedProperties = Pick<
  IdentifiedSession,
  | 'id'
  | 'from'
  | 'to'
  | 'seq'
  | 'ack'
  | 'seqSent'
  | 'sendBuffer'
  | 'sendBufferDrainWaiter'
  | 'telemetry'
  | 'options'
>;

export type SessionId = string;

export interface IdentifiedSessionListeners {
  onMessageSendFailure: (
    msg: PartialTransportMessage & { seq: number },
    reason: string,
  ) => void;
}

// all sessions where we know the other side's client id
export interface IdentifiedSessionProps extends CommonSessionProps {
  id: SessionId;
  to: TransportClientId;
  seq: number;
  ack: number;
  seqSent: number;
  sendBuffer: Array<EncodedTransportMessage>;
  sendBufferDrainWaiter: PromiseWithResolvers<void> | undefined;
  streamSendBufferDrainWaiters?: Map<string, PromiseWithResolvers<void>>;
  telemetry: TelemetryInfo;
  protocolVersion: ProtocolVersion;
  listeners: IdentifiedSessionListeners;
}

export abstract class IdentifiedSession extends CommonSession {
  readonly id: SessionId;
  readonly telemetry: TelemetryInfo;
  readonly to: TransportClientId;
  readonly protocolVersion: ProtocolVersion;
  listeners: IdentifiedSessionListeners;

  /**
   * Index of the message we will send next (excluding handshake)
   */
  seq: number;

  /**
   * Last seq we sent over the wire this session (excluding handshake) and retransmissions
   */
  seqSent: number;

  /**
   * Number of unique messages we've received this session (excluding handshake)
   */
  ack: number;
  sendBuffer: Array<EncodedTransportMessage>;

  /**
   * Shared promise for pending {@link waitForSendBufferDrain} calls, created
   * lazily on the first waiter of a pressure episode and cleared on drain.
   * Carried across session state transitions alongside {@link sendBuffer}.
   */
  sendBufferDrainWaiter: PromiseWithResolvers<void> | undefined;
  readonly streamSendBufferDrainWaiters: Map<
    string,
    PromiseWithResolvers<void>
  >;

  private readonly streamSendBufferSizes = new Map<string, number>();

  constructor(props: IdentifiedSessionProps) {
    const {
      id,
      to,
      seq,
      ack,
      sendBuffer,
      sendBufferDrainWaiter,
      telemetry,
      log,
      protocolVersion,
      seqSent: messagesSent,
      listeners,
    } = props;
    super(props);
    this.id = id;
    this.to = to;
    this.seq = seq;
    this.ack = ack;
    this.sendBuffer = sendBuffer;
    this.sendBufferDrainWaiter = sendBufferDrainWaiter;
    this.streamSendBufferDrainWaiters =
      props.streamSendBufferDrainWaiters ??
      new Map<string, PromiseWithResolvers<void>>();
    for (const msg of sendBuffer) {
      this.addStreamBufferEntry(msg);
    }
    this.telemetry = telemetry;
    this.log = log;
    this.protocolVersion = protocolVersion;
    this.seqSent = messagesSent;
    this.listeners = listeners;
  }

  get loggingMetadata(): MessageMetadata {
    const metadata: MessageMetadata = {
      clientId: this.from,
      connectedTo: this.to,
      sessionId: this.id,
    };

    if (this.telemetry.span.isRecording()) {
      const spanContext = this.telemetry.span.spanContext();
      metadata.telemetry = {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      };
    }

    return metadata;
  }

  encodeMsg(partialMsg: PartialTransportMessage): EncodeResult {
    const msg = {
      ...partialMsg,
      id: generateId(),
      to: this.to,
      from: this.from,
      seq: this.seq,
      ack: this.ack,
    };

    const encoded = this.codec.toBuffer(msg);
    if (!encoded.ok) {
      // safety: onMessageSendFailure tears down the session via protocol error,
      // which emits sessionStatus 'closing' and cleans up all procedure listeners.
      this.listeners.onMessageSendFailure(
        { ...partialMsg, seq: this.seq },
        encoded.reason,
      );

      return encoded;
    }

    this.seq++;

    return {
      ok: true,
      value: {
        id: msg.id,
        seq: msg.seq,
        msg: partialMsg,
        data: encoded.value,
      },
    };
  }

  nextSeq(): number {
    return this.sendBuffer.length > 0 ? this.sendBuffer[0].seq : this.seq;
  }

  isSendBufferFull(streamId?: string): boolean {
    if (
      streamId !== undefined &&
      this.options.streamSendBufferHighWaterMark !== undefined
    ) {
      return (
        (this.streamSendBufferSizes.get(streamId) ?? 0) >=
        this.options.streamSendBufferHighWaterMark
      );
    }

    return this.sendBuffer.length >= this.options.sendBufferHighWaterMark;
  }

  /**
   * Resolves once the send buffer drops back below
   * {@link SessionOptions.sendBufferHighWaterMark}, or immediately if it
   * already is. Also resolves (never rejects) when the session closes so
   * waiting producers don't hang forever.
   */
  waitForSendBufferDrain(streamId?: string): Promise<void> {
    if (!this.isSendBufferFull(streamId)) {
      return Promise.resolve();
    }

    if (
      streamId !== undefined &&
      this.options.streamSendBufferHighWaterMark !== undefined
    ) {
      let waiter = this.streamSendBufferDrainWaiters.get(streamId);
      if (!waiter) {
        waiter = createPromiseWithResolvers();
        this.streamSendBufferDrainWaiters.set(streamId, waiter);
      }

      return waiter.promise;
    }

    this.sendBufferDrainWaiter ??= createPromiseWithResolvers();

    return this.sendBufferDrainWaiter.promise;
  }

  protected notifySendBufferDrain(): void {
    if (!this.isSendBufferFull()) {
      this.sendBufferDrainWaiter?.resolve();
      this.sendBufferDrainWaiter = undefined;
    }
    for (const [streamId, waiter] of this.streamSendBufferDrainWaiters) {
      if (!this.isSendBufferFull(streamId)) {
        waiter.resolve();
        this.streamSendBufferDrainWaiters.delete(streamId);
      }
    }
  }

  private addStreamBufferEntry(msg: EncodedTransportMessage): void {
    if (this.options.streamSendBufferHighWaterMark === undefined) {
      return;
    }
    const streamId = msg.msg.streamId;
    this.streamSendBufferSizes.set(
      streamId,
      (this.streamSendBufferSizes.get(streamId) ?? 0) + 1,
    );
  }

  protected bufferMessage(msg: EncodedTransportMessage): void {
    this.sendBuffer.push(msg);
    this.addStreamBufferEntry(msg);
  }

  protected acknowledgeSendBuffer(ack: number): void {
    this.sendBuffer = this.sendBuffer.filter((msg) => {
      if (msg.seq >= ack) {
        return true;
      }
      if (this.options.streamSendBufferHighWaterMark === undefined) {
        return false;
      }
      const streamId = msg.msg.streamId;
      const remaining = (this.streamSendBufferSizes.get(streamId) ?? 1) - 1;
      if (remaining === 0) {
        this.streamSendBufferSizes.delete(streamId);
      } else {
        this.streamSendBufferSizes.set(streamId, remaining);
      }

      return false;
    });
    this.notifySendBufferDrain();
  }

  send(msg: PartialTransportMessage): SendResult {
    const encodeResult = this.encodeMsg(msg);
    if (!encodeResult.ok) {
      return encodeResult;
    }

    this.bufferMessage(encodeResult.value);

    return {
      ok: true,
      value: encodeResult.value.id,
    };
  }

  _handleStateExit(): void {
    // noop
  }

  _handleClose(): void {
    // zero out the buffer
    this.sendBuffer.length = 0;
    this.streamSendBufferSizes.clear();
    // wake any producers waiting for drain so they don't hang forever,
    // they should check isWritable/isSendBufferFull before writing again
    this.notifySendBufferDrain();
    this.telemetry.span.end();
  }
}

export interface IdentifiedSessionWithGracePeriodListeners
  extends IdentifiedSessionListeners {
  onSessionGracePeriodElapsed: () => void;
}

export interface IdentifiedSessionWithGracePeriodProps
  extends IdentifiedSessionProps {
  graceExpiryTime: number;
  listeners: IdentifiedSessionWithGracePeriodListeners;
}

export abstract class IdentifiedSessionWithGracePeriod extends IdentifiedSession {
  graceExpiryTime: number;
  protected gracePeriodTimeout?: ReturnType<typeof setTimeout>;

  listeners: IdentifiedSessionWithGracePeriodListeners;

  constructor(props: IdentifiedSessionWithGracePeriodProps) {
    super(props);
    this.listeners = props.listeners;

    this.graceExpiryTime = props.graceExpiryTime;
    this.gracePeriodTimeout = setTimeout(() => {
      this.listeners.onSessionGracePeriodElapsed();
    }, this.graceExpiryTime - Date.now());
  }

  _handleStateExit(): void {
    super._handleStateExit();

    if (this.gracePeriodTimeout) {
      clearTimeout(this.gracePeriodTimeout);
      this.gracePeriodTimeout = undefined;
    }
  }

  _handleClose(): void {
    super._handleClose();
  }
}
