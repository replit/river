import { Type, TSchema, Static } from '@sinclair/typebox';
import { PropagationContext } from '../tracing';
import { generateId } from './id';
import {
  ErrResult,
  InputReaderErrorSchema,
  OutputReaderErrorSchema,
} from '../router';

/**
 * Control flags for transport messages.
 */
export const enum ControlFlags {
  /**
   * Used in heartbeat messages.
   */
  AckBit = 0b00001,
  /**
   * Used in stream open requests.
   */
  StreamOpenBit = 0b00010,
  /**
   * Used when writer closes the stream.
   */
  StreamClosedBit = 0b01000,
  /**
   * Used when readers no longer wish to receive messages.
   */
  StreamCloseRequestBit = 0b10000,
  /**
   * Used when a stream is aborted due to cancellation or errors
   */
  StreamAbortBit = 0b00100,
}

/**
 * Generic Typebox schema for a transport message.
 * @template T The type of the payload.
 * @param {T} t The payload schema.
 * @returns The transport message schema.
 */
export const TransportMessageSchema = <T extends TSchema>(t: T) =>
  Type.Object({
    id: Type.String(),
    from: Type.String(),
    to: Type.String(),
    seq: Type.Integer(),
    ack: Type.Integer(),
    serviceName: Type.Optional(Type.String()),
    procedureName: Type.Optional(Type.String()),
    streamId: Type.String(),
    controlFlags: Type.Integer(),
    tracing: Type.Optional(
      Type.Object({
        traceparent: Type.String(),
        tracestate: Type.String(),
      }),
    ),
    payload: t,
  });

/**
 * Defines the schema for a transport acknowledgement message. This is never constructed manually
 * and is only used internally by the library for tracking inflight messages.
 * @returns The transport message schema.
 */
export const ControlMessageAckSchema = Type.Object({
  type: Type.Literal('ACK'),
});

/**
 * Defines the schema for a transport close message. This is never constructed manually and is only
 * used internally by the library for closing and cleaning up streams.
 */
export const ControlMessageCloseSchema = Type.Object({
  type: Type.Literal('CLOSE'),
});

export const PROTOCOL_VERSION = 'v2.0';
export const ControlMessageHandshakeRequestSchema = Type.Object({
  type: Type.Literal('HANDSHAKE_REQ'),
  protocolVersion: Type.String(),
  sessionId: Type.String(),
  /**
   * Specifies what the server's expected session state (from the pov of the client). This can be
   * used by the server to know whether this is a new or a reestablished connection, and whether it
   * is compatible with what it already has.
   */
  expectedSessionState: Type.Object({
    // what the client expects the server to send next
    nextExpectedSeq: Type.Integer(),
    // TODO: remove optional once we know all servers
    // are nextSentSeq here
    // what the server expects the client to send next
    nextSentSeq: Type.Optional(Type.Integer()),
  }),

  metadata: Type.Optional(Type.Unknown()),
});

export const HandshakeErrorRetriableResponseCodes = Type.Union([
  Type.Literal('SESSION_STATE_MISMATCH'),
]);

export const HandshakeErrorFatalResponseCodes = Type.Union([
  Type.Literal('MALFORMED_HANDSHAKE_META'),
  Type.Literal('MALFORMED_HANDSHAKE'),
  Type.Literal('PROTOCOL_VERSION_MISMATCH'),
  Type.Literal('REJECTED_BY_CUSTOM_HANDLER'),
]);

export const HandshakeErrorResponseCodes = Type.Union([
  HandshakeErrorRetriableResponseCodes,
  HandshakeErrorFatalResponseCodes,
]);

export const ControlMessageHandshakeResponseSchema = Type.Object({
  type: Type.Literal('HANDSHAKE_RESP'),
  status: Type.Union([
    Type.Object({
      ok: Type.Literal(true),
      sessionId: Type.String(),
    }),
    Type.Object({
      ok: Type.Literal(false),
      reason: Type.String(),
      // TODO: remove optional once we know all servers
      // are sending code here
      code: Type.Optional(HandshakeErrorResponseCodes),
    }),
  ]),
});

export const ControlMessagePayloadSchema = Type.Union([
  ControlMessageCloseSchema,
  ControlMessageAckSchema,
  ControlMessageHandshakeRequestSchema,
  ControlMessageHandshakeResponseSchema,
]);

/**
 * Defines the schema for an opaque transport message that is agnostic to any
 * procedure/service.
 * @returns The transport message schema.
 */
export const OpaqueTransportMessageSchema = TransportMessageSchema(
  Type.Unknown(),
);

/**
 * Represents a transport message. This is the same type as {@link TransportMessageSchema} but
 * we can't statically infer generics from generic Typebox schemas so we have to define it again here.
 *
 * TypeScript can't enforce types when a bitmask is involved, so these are the semantics of
 * `controlFlags`:
 * * If `controlFlags & StreamOpenBit == StreamOpenBit`, `streamId` must be set to a unique value
 *   (suggestion: use `nanoid`).
 * * If `controlFlags & StreamOpenBit == StreamOpenBit`, `serviceName` and `procedureName` must be set.
 * * If `controlFlags & StreamClosedBit == StreamClosedBit` and the kind is `stream` or `subscription`,
 *   `payload` should be discarded (usually contains a control message).
 * * If `controlFlags & AckBit == AckBit`, the message is an explicit acknowledgement message and doesn't
 *   contain any payload that is relevant to the application so should not be delivered.
 * @template Payload The type of the payload.
 */
export interface TransportMessage<Payload = unknown> {
  id: string;
  from: TransportClientId;
  to: TransportClientId;
  seq: number;
  ack: number;
  serviceName?: string;
  procedureName?: string;
  streamId: string;
  controlFlags: number;
  tracing?: PropagationContext;
  payload: Payload;
}

export type PartialTransportMessage<Payload = unknown> = Omit<
  TransportMessage<Payload>,
  'id' | 'from' | 'to' | 'seq' | 'ack'
>;

export function handshakeRequestMessage({
  from,
  to,
  sessionId,
  expectedSessionState,
  metadata,
  tracing,
}: {
  from: TransportClientId;
  to: TransportClientId;
  sessionId: string;
  expectedSessionState: Static<
    typeof ControlMessageHandshakeRequestSchema
  >['expectedSessionState'];
  metadata?: unknown;
  tracing?: PropagationContext;
}): TransportMessage<Static<typeof ControlMessageHandshakeRequestSchema>> {
  return {
    id: generateId(),
    from,
    to,
    seq: 0,
    ack: 0,
    streamId: generateId(),
    controlFlags: 0,
    tracing,
    payload: {
      type: 'HANDSHAKE_REQ',
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      expectedSessionState,
      metadata,
    } satisfies Static<typeof ControlMessageHandshakeRequestSchema>,
  };
}

/**
 * This is a reason that can be given during the handshake to indicate that the peer has the wrong
 * session state.
 */
export const SESSION_STATE_MISMATCH = 'session state mismatch';

export function handshakeResponseMessage({
  from,
  to,
  status,
}: {
  from: TransportClientId;
  to: TransportClientId;
  status: Static<typeof ControlMessageHandshakeResponseSchema>['status'];
}): TransportMessage<Static<typeof ControlMessageHandshakeResponseSchema>> {
  return {
    id: generateId(),
    from,
    to,
    seq: 0,
    ack: 0,
    streamId: generateId(),
    controlFlags: 0,
    payload: {
      type: 'HANDSHAKE_RESP',
      status,
    } satisfies Static<typeof ControlMessageHandshakeResponseSchema>,
  };
}

export function closeStreamMessage(streamId: string): PartialTransportMessage {
  return {
    streamId,
    controlFlags: ControlFlags.StreamClosedBit,
    payload: {
      type: 'CLOSE' as const,
    } satisfies Static<typeof ControlMessagePayloadSchema>,
  };
}

export function requestCloseStreamMessage(
  streamId: string,
): PartialTransportMessage {
  return {
    streamId,
    controlFlags: ControlFlags.StreamCloseRequestBit,
    payload: {
      type: 'CLOSE' as const,
    } satisfies Static<typeof ControlMessagePayloadSchema>,
  };
}

export function abortMessage(
  streamId: string,
  payload: ErrResult<
    Static<typeof OutputReaderErrorSchema | typeof InputReaderErrorSchema>
  >,
) {
  return {
    streamId,
    controlFlags: ControlFlags.StreamAbortBit,
    payload,
  };
}

/**
 * A type alias for a transport message with an opaque payload.
 * @template T - The type of the opaque payload.
 */
export type OpaqueTransportMessage = TransportMessage;
export type TransportClientId = string;

/**
 * Checks if the given control flag (usually found in msg.controlFlag) is an ack message.
 * @param controlFlag - The control flag to check.
 * @returns True if the control flag contains the AckBit, false otherwise.
 */
export function isAck(controlFlag: number): boolean {
  /* eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison */
  return (controlFlag & ControlFlags.AckBit) === ControlFlags.AckBit;
}

/**
 * Checks if the given control flag (usually found in msg.controlFlag) is a stream open message.
 * @param controlFlag - The control flag to check.
 * @returns True if the control flag contains the StreamOpenBit, false otherwise.
 */
export function isStreamOpen(controlFlag: number): boolean {
  return (
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison */
    (controlFlag & ControlFlags.StreamOpenBit) === ControlFlags.StreamOpenBit
  );
}

/**
 * Checks if the given control flag (usually found in msg.controlFlag) is a stream close message.
 * @param controlFlag - The control flag to check.
 * @returns True if the control flag contains the StreamCloseBit, false otherwise.
 */
export function isStreamClose(controlFlag: number): boolean {
  return (
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison */
    (controlFlag & ControlFlags.StreamClosedBit) ===
    ControlFlags.StreamClosedBit
  );
}

/**
 * Checks if the given control flag (usually found in msg.controlFlag) is a stream close request message.
 * @param controlFlag - The control flag to check.
 * @returns True if the control flag contains the StreamCloseBit, false otherwise.
 */
export function isStreamCloseRequest(controlFlag: number): boolean {
  return (
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison */
    (controlFlag & ControlFlags.StreamCloseRequestBit) ===
    ControlFlags.StreamCloseRequestBit
  );
}

/**
 * Checks if the given control flag (usually found in msg.controlFlag) is an abort message.
 * @param controlFlag - The control flag to check.
 * @returns True if the control flag contains the AbortBit, false otherwise
 */
export function isStreamAbort(controlFlag: number): boolean {
  return (
    /* eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison */
    (controlFlag & ControlFlags.StreamAbortBit) === ControlFlags.StreamAbortBit
  );
}
