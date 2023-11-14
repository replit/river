import { Codec } from '../codec/types';
import { Value } from '@sinclair/typebox/value';
import {
  ControlFlags,
  MessageId,
  OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
  TransportAckSchema,
  TransportClientId,
  isAck,
  reply,
} from './message';
import { log } from '../logging';

export abstract class Transport {
  codec: Codec;
  clientId: TransportClientId;
  handlers: Set<(msg: OpaqueTransportMessage) => void>;

  // TODO; we can do much better here on retry (maybe resending the sendBuffer on fixed interval)
  sendBuffer: Map<MessageId, OpaqueTransportMessage>;

  constructor(codec: Codec, clientId: TransportClientId) {
    this.handlers = new Set();
    this.sendBuffer = new Map();
    this.codec = codec;
    this.clientId = clientId;
  }

  onMessage(msg: string) {
    const parsedMsg = this.codec.fromStringBuf(msg);
    if (parsedMsg === null) {
      log?.warn(`${this.clientId} -- received malformed msg: ${msg}`);
      return;
    }

    if (
      Value.Check(TransportAckSchema, parsedMsg) &&
      isAck(parsedMsg.controlFlags)
    ) {
      // process ack
      log?.info(`${this.clientId} -- received ack: ${msg}`);
      if (this.sendBuffer.has(parsedMsg.payload.ack)) {
        this.sendBuffer.delete(parsedMsg.payload.ack);
      }
    } else if (Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
      // regular river message
      log?.info(`${this.clientId} -- received msg: ${msg}`);

      // ignore if not for us
      if (parsedMsg.to !== this.clientId && parsedMsg.to !== 'broadcast') {
        return;
      }

      // handle actual message
      for (const handler of this.handlers) {
        handler(parsedMsg);
      }

      const ackMsg = reply(parsedMsg, { ack: parsedMsg.id });
      ackMsg.controlFlags = ControlFlags.AckBit;
      ackMsg.from = this.clientId;
      this.send(ackMsg);
    } else {
      log?.warn(`${this.clientId} -- received invalid transport msg: ${msg}`);
    }
  }

  addMessageListener(handler: (msg: OpaqueTransportMessage) => void): void {
    this.handlers.add(handler);
  }

  removeMessageListener(handler: (msg: OpaqueTransportMessage) => void): void {
    this.handlers.delete(handler);
  }

  abstract send(msg: OpaqueTransportMessage): MessageId;
  abstract close(): Promise<void>;
}
