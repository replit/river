import { Type, TSchema } from '@sinclair/typebox';
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
    serviceName: Type.String(),
    procedureName: Type.String(),
    streamId: Type.String(),
    controlFlags: Type.Integer(),
    payload: t,
  });

/**
 * Defines the schema for a transport acknowledgement message. This is never constructed manually
 * and is only used internally by the library for tracking inflight messages.
 * @returns The transport message schema.
 */
export const TransportAckSchema = TransportMessageSchema(
  Type.Object({
    ack: Type.String(),
  }),
);

export const ControlMessagePayloadSchema = Type.Object({
  type: Type.Literal('CLOSE'),
});

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
 * @template Payload The type of the payload.
 */
export type TransportMessage<
  Payload extends Record<string, unknown> | unknown = Record<string, unknown>,
> = {
  id: string;
  from: string;
  to: string;
  serviceName: string;
  procedureName: string;
  streamId: string;
  controlFlags: number;
  payload: Payload;
};

export type MessageId = string;

/**
 * A type alias for a transport message with an opaque payload.
 * @template T - The type of the opaque payload.
 */
export type OpaqueTransportMessage = TransportMessage<unknown>;
export type TransportClientId = string;

/**
 * Creates a transport message with the given parameters. You shouldn't need to call this manually unless
 * you're writing a test.
 * @param from The sender of the message.
 * @param to The intended recipient of the message.
 * @param service The name of the service the message is intended for.
 * @param proc The name of the procedure the message is intended for.
 * @param stream The ID of the stream the message is intended for.
 * @param payload The payload of the message.
 * @returns A TransportMessage object with the given parameters.
 */
export function msg<Payload extends object>(
  from: string,
  to: string,
  service: string,
  proc: string,
  stream: string,
  payload: Payload,
): TransportMessage<Payload> {
  return {
    id: nanoid(),
    to,
    from,
    serviceName: service,
    procedureName: proc,
    streamId: stream,
    controlFlags: 0,
    payload,
  };
}

/**
 * Creates a new transport message as a response to the given message.
 * @param msg The original message to respond to.
 * @param response The payload of the response message.
 * @returns A new transport message with appropriate to, from, and payload fields
 */
export function reply<Payload extends object>(
  msg: OpaqueTransportMessage,
  response: Payload,
): TransportMessage<Payload> {
  return {
    ...msg,
    id: nanoid(),
    to: msg.from,
    from: msg.to,
    payload: response,
  };
}

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
