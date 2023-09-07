import { type Static, Type, TSchema } from '@sinclair/typebox';
import { nanoid } from 'nanoid';

// look at https://github.com/websockets/ws#use-the-nodejs-streams-api for a duplex stream we can use
export const TransportMessageSchema = <T extends TSchema>(t: T) =>
  Type.Object({
    id: Type.String(),
    from: Type.String(),
    to: Type.String(),
    serviceName: Type.String(),
    procedureName: Type.String(),
    payload: t,
  });

export const OpaqueTransportMessageSchema = TransportMessageSchema(Type.Unknown());
export type TransportMessage<Payload extends TSchema> = ReturnType<
  typeof TransportMessageSchema<Payload>
>;

export type MessageId = string;

export type OpaqueTransportMessage = Static<typeof OpaqueTransportMessageSchema>;
export type TransportClientId = 'SERVER' | string;
export const TransportAckSchema = Type.Object({
  from: Type.String(),
  replyTo: Type.String(),
});

export type TransportMessageAck = Static<typeof TransportAckSchema>;

export function msg<Payload extends object>(
  from: string,
  to: string,
  service: string,
  proc: string,
  payload: Payload,
) {
  return {
    id: nanoid(),
    to,
    from,
    serviceName: service,
    procedureName: proc,
    payload,
  } satisfies OpaqueTransportMessage;
}

export function ack(msg: OpaqueTransportMessage): TransportMessageAck {
  return {
    from: msg.to,
    replyTo: msg.id,
  };
}

export function reply<Payload extends object>(msg: OpaqueTransportMessage, response: Payload) {
  return {
    ...msg,
    id: nanoid(),
    to: msg.from,
    from: msg.to,
    payload: response,
  } satisfies OpaqueTransportMessage;
}
