import { Type, TSchema } from '@sinclair/typebox';
import { nanoid } from 'nanoid';

// bit masks for control flags
export const enum ControlFlags {
  AckBit = 0b0001,
  StreamOpenBit = 0b0010,
  StreamClosedBit = 0b0100,
}

// look at https://github.com/websockets/ws#use-the-nodejs-streams-api for a duplex stream we can use
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

export const TransportAckSchema = TransportMessageSchema(
  Type.Object({
    ack: Type.String(),
  }),
);
export const OpaqueTransportMessageSchema = TransportMessageSchema(
  Type.Unknown(),
);
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
export type OpaqueTransportMessage = TransportMessage<unknown>;
export type TransportClientId = 'SERVER' | string;

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

export function isAck(controlFlag: number): boolean {
  return (controlFlag & ControlFlags.AckBit) === ControlFlags.AckBit;
}

export function isStreamOpen(controlFlag: number): boolean {
  return (
    (controlFlag & ControlFlags.StreamOpenBit) === ControlFlags.StreamOpenBit
  );
}

export function isStreamClose(controlFlag: number): boolean {
  return (
    (controlFlag & ControlFlags.StreamClosedBit) ===
    ControlFlags.StreamClosedBit
  );
}
