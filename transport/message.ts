import { Type, TSchema, Static } from '@sinclair/typebox';
import { nanoid } from 'nanoid';
import { Connection, Session } from './session';
import { PropagationContext } from '../tracing';

/**
 * Control flags for transport messages.
 * An RPC message is coded with StreamOpenBit | StreamClosedBit.
 * Streams are expected to start with StreamOpenBit sent and the client SHOULD send an empty
 * message with StreamClosedBit to close the stream handler on the server, indicating that
 * it will not be using the stream anymore.
 */
export const enum ControlFlags {
  AckBit = 0b0001,
  StreamOpenBit = 0b0010,
  StreamClosedBit = 0b0100,
}

/**
 * Metadata associated with a handshake request, as sent by the client.
 *
 * You should use declaration merging to extend this interface
 * with whatever you need. For example, if you need to store an
 * identifier for the client, you could do:
 * ```
 * declare module '@replit/river' {
 *   interface HandshakeMetadataClient {
 *     id: string;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface HandshakeRequestMetadata {}

/**
 * Metadata associated with a handshake response, after the server
 * has processed the data in {@link HandshakeRequestMetadata}. This
 * is a separate interface for multiple reasons, but one of the main
 * ones is that the server should remove any sensitive data from the
 * client's request metadata before storing it in the session, that
 * way no secrets are persisted in memory.
 *
 * You should use declaration merging to extend this interface
 * with whatever you need. For example, if you need to store an
 * identifier for the client, you could do:
 * ```
 * declare module '@replit/river' {
 *   interface HandshakeMetadataServer {
 *     id: string;
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ParsedHandshakeMetadata {}

/**
 * Options for extending the client handshake process.
 */
export interface ClientHandshakeOptions {
  /**
   * Schema for the metadata that the client sends to the server
   * during the handshake.
   *
   * Needs to match {@link HandshakeRequestMetadata}.
   */
  schema: TSchema;

  /**
   * Gets the {@link HandshakeRequestMetadata} to send to the server.
   */
  get: () => HandshakeRequestMetadata | Promise<HandshakeRequestMetadata>;
}

/**
 * Options for extending the server handshake process.
 */
export interface ServerHandshakeOptions {
  /**
   * Schema for the metadata that the server receives from the client
   * during the handshake.
   *
   * Needs to match {@link HandshakeRequestMetadata}.
   */
  requestSchema: TSchema;

  /**
   * Schema for the transformed metadata that is then associated with the
   * client's session.
   *
   * Needs to match {@link ParsedHandshakeMetadata}.
   */
  parsedSchema: TSchema;

  /**
   * Parses the {@link HandshakeRequestMetadata} sent by the client, transforming
   * it into {@link ParsedHandshakeMetadata}.
   *
   * May return `false` if the client should be rejected.
   *
   * @param metadata - The metadata sent by the client.
   * @param session - The session that the client would be associated with.
   * @param isReconnect - Whether the client is reconnecting to the session,
   *                      or if this is a new session.
   */
  parse: (
    metadata: HandshakeRequestMetadata,
    session: Session<Connection>,
    isReconnect: boolean,
  ) =>
    | false
    | ParsedHandshakeMetadata
    | Promise<false | ParsedHandshakeMetadata>;
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

export const PROTOCOL_VERSION = 'v1.1';
export const ControlMessageHandshakeRequestSchema = Type.Object({
  type: Type.Literal('HANDSHAKE_REQ'),
  protocolVersion: Type.String(),
  sessionId: Type.String(),
  metadata: Type.Optional(Type.Unknown()),
});

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
  from: string;
  to: string;
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

export function handshakeRequestMessage(
  from: TransportClientId,
  to: TransportClientId,
  sessionId: string,
  metadata?: HandshakeRequestMetadata,
  tracing?: PropagationContext,
): TransportMessage<Static<typeof ControlMessageHandshakeRequestSchema>> {
  return {
    id: nanoid(),
    from,
    to,
    seq: 0,
    ack: 0,
    streamId: nanoid(),
    controlFlags: 0,
    tracing,
    payload: {
      type: 'HANDSHAKE_REQ',
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      metadata,
    } satisfies Static<typeof ControlMessageHandshakeRequestSchema>,
  };
}

export function handshakeResponseMessage(
  from: TransportClientId,
  to: TransportClientId,
  status: Static<typeof ControlMessageHandshakeResponseSchema>['status'],
): TransportMessage<Static<typeof ControlMessageHandshakeResponseSchema>> {
  return {
    id: nanoid(),
    from,
    to,
    seq: 0,
    ack: 0,
    streamId: nanoid(),
    controlFlags: 0,
    payload: {
      type: 'HANDSHAKE_RESP',
      status,
    } satisfies Static<typeof ControlMessageHandshakeResponseSchema>,
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
