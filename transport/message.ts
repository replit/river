import { Type, TSchema, Static } from '@sinclair/typebox';
import { nanoid } from 'nanoid';

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
    serviceName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    procedureName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    streamId: Type.String(),
    controlFlags: Type.Integer(),
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

export const PROTOCOL_VERSION = 'v1';
export const ControlMessageHandshakeRequestSchema = Type.Object({
  type: Type.Literal('HANDSHAKE_REQ'),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
});

export const ControlMessageHandshakeResponseSchema = Type.Object({
  type: Type.Literal('HANDSHAKE_RESP'),
  status: Type.Union([
    Type.Object({
      ok: Type.Literal(true),
      instanceId: Type.String(),
    }),
    Type.Object({
      ok: Type.Literal(false),
      reason: Type.Union([Type.Literal('VERSION_MISMATCH')]),
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
 * @template Payload The type of the payload.
 */
export type TransportMessage<
  Payload extends Record<string, unknown> | unknown = Record<string, unknown>,
> = {
  id: string;
  from: string;
  to: string;
  seq: number;
  ack: number;
  serviceName?: string;
  procedureName?: string;
  streamId: string;
  controlFlags: number;
  payload: Payload;
};

export type PartialTransportMessage<
  Payload extends Record<string, unknown> | unknown = Record<string, unknown>,
> = Omit<TransportMessage<Payload>, 'id' | 'from' | 'to' | 'seq' | 'ack'>;

export function bootRequestMessage(
  from: TransportClientId,
  to: TransportClientId,
): TransportMessage<Static<typeof ControlMessageHandshakeRequestSchema>> {
  return {
    id: nanoid(),
    from,
    to,
    seq: 0,
    ack: 0,
    streamId: nanoid(),
    controlFlags: 0,
    payload: {
      type: 'HANDSHAKE_REQ',
      protocolVersion: PROTOCOL_VERSION,
    } satisfies Static<typeof ControlMessageHandshakeRequestSchema>,
  };
}

export function bootResponseMessage(
  from: TransportClientId,
  instanceId: string,
  to: TransportClientId,
  ok: boolean,
): TransportMessage<Static<typeof ControlMessageHandshakeResponseSchema>> {
  return {
    id: nanoid(),
    from,
    to,
    seq: 0,
    ack: 0,
    streamId: nanoid(),
    controlFlags: 0,
    payload: (ok
      ? {
          type: 'HANDSHAKE_RESP',
          status: {
            ok: true,
            instanceId,
          },
        }
      : {
          type: 'HANDSHAKE_RESP',
          status: {
            ok: false,
            reason: 'VERSION_MISMATCH',
          },
        }) satisfies Static<typeof ControlMessageHandshakeResponseSchema>,
  };
}

/**
 * A type alias for a transport message with an opaque payload.
 * @template T - The type of the opaque payload.
 */
export type OpaqueTransportMessage = TransportMessage<unknown>;
export type TransportClientId = string;

/**
 * Checks if the given control flag (usually found in msg.controlFlag) is an ack message.
 * @param controlFlag - The control flag to check.
 * @returns True if the control flag contains the AckBit, false otherwise.
 */
export function isAck(controlFlag: number): boolean {
  return (controlFlag & ControlFlags.AckBit) === ControlFlags.AckBit;
}

/**
 * Checks if the given control flag (usually found in msg.controlFlag) is a stream open message.
 * @param controlFlag - The control flag to check.
 * @returns True if the control flag contains the StreamOpenBit, false otherwise.
 */
export function isStreamOpen(controlFlag: number): boolean {
  return (
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
    (controlFlag & ControlFlags.StreamClosedBit) ===
    ControlFlags.StreamClosedBit
  );
}
