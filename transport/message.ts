import { type Static, Type, TSchema } from '@sinclair/typebox';
import { nanoid } from 'nanoid';

// look at https://github.com/websockets/ws#use-the-nodejs-streams-api for a duplex stream we can use
export const TransportMessageSchema = <T extends TSchema>(t: T) =>
  Type.Object({
    id: Type.String(),
    replyTo: Type.Optional(Type.String()),
    from: Type.String(),
    to: Type.String(),
    serviceName: Type.String(),
    procedureName: Type.String(),
    payload: t,
  });

export const OpaqueTransportMessageSchema = TransportMessageSchema(
  Type.Unknown(),
);
export type TransportMessage<
  Payload extends Record<string, unknown> | unknown = Record<string, unknown>,
> = {
  id: string;
  replyTo?: string;
  from: string;
  to: string;
  serviceName: string;
  procedureName: string;
  payload: Payload;
};

export type MessageId = string;
export type OpaqueTransportMessage = TransportMessage<unknown>;
export type TransportClientId = 'SERVER' | string;
export const TransportAckSchema = Type.Object({
  from: Type.String(),
  ack: Type.String(),
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

export function payloadToTransportMessage<Payload extends object>(
  payload: Payload,
) {
  return msg('client', 'SERVER', 'service', 'procedure', payload);
}

export function ack(msg: OpaqueTransportMessage): TransportMessageAck {
  return {
    from: msg.to,
    ack: msg.id,
  };
}

export function reply<Payload extends object>(
  msg: OpaqueTransportMessage,
  response: Payload,
) {
  return {
    ...msg,
    id: nanoid(),
    replyTo: msg.id,
    to: msg.from,
    from: msg.to,
    payload: response,
  } satisfies OpaqueTransportMessage;
}
