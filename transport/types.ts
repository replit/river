import { Codec } from '../codec/types';
import { Value } from '@sinclair/typebox/value';
import {
  MessageId,
  OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
  TransportAckSchema,
  TransportClientId,
  TransportMessageAck,
  ack,
} from './message';

export abstract class Transport {
  codec: Codec;
  clientId: TransportClientId;
  handlers: Set<(msg: OpaqueTransportMessage) => void>;
  sendBuffer: Map<MessageId, OpaqueTransportMessage>;

  constructor(codec: Codec, clientId: TransportClientId) {
    this.handlers = new Set();
    this.sendBuffer = new Map();
    this.codec = codec;
    this.clientId = clientId;
  }

  onMessage(msg: string) {
    const parsedMsg = this.codec.fromStringBuf(msg.toString());
    if (Value.Check(TransportAckSchema, parsedMsg)) {
      // process ack
      if (this.sendBuffer.has(parsedMsg.replyTo)) {
        this.sendBuffer.delete(parsedMsg.replyTo);
      }
    } else if (Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
      // ignore if not for us
      if (parsedMsg.to !== this.clientId && parsedMsg.to !== 'broadcast') {
        return;
      }

      // handle actual message
      for (const handler of this.handlers) {
        handler(parsedMsg);
      }

      this.send(ack(parsedMsg));
    }
  }

  addMessageListener(handler: (msg: OpaqueTransportMessage) => void): void {
    this.handlers.add(handler);
  }

  removeMessageListener(handler: (msg: OpaqueTransportMessage) => void): void {
    this.handlers.delete(handler);
  }

  abstract send(msg: OpaqueTransportMessage | TransportMessageAck): MessageId;
  abstract close(): Promise<void>;
}
