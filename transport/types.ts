import { type Static, Type } from "@sinclair/typebox";
import { Codec } from "../codec/types";
import { Value } from "@sinclair/typebox/value";

// look at https://github.com/websockets/ws#use-the-nodejs-streams-api for a duplex stream we can use
export const TransportMessageSchema = Type.Object({
  id: Type.String(),
  from: Type.String(),
  to: Type.Union([Type.String(), Type.Literal("broadcast")]),
  serviceName: Type.String(),
  procedureName: Type.String(),
  payload: Type.Unknown(), // this is generic but gets narrowed at the service level
});

export type MessageId = string;

export type TransportMessage = Static<typeof TransportMessageSchema>;
export type TransportClientId = "SERVER" | string;
export const TransportAckSchema = Type.Object({
  from: Type.String(),
  replyTo: Type.String(),
});

export type TransportMessageAck = Static<typeof TransportAckSchema>;

export abstract class Transport {
  codec: Codec;
  clientId: TransportClientId;
  handlers: Set<(msg: TransportMessage) => void>;
  sendBuffer: Map<MessageId, TransportMessage>;

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
    } else if (Value.Check(TransportMessageSchema, parsedMsg)) {
      // ignore if not for us
      if (parsedMsg.to !== this.clientId && parsedMsg.to !== "broadcast") {
        return;
      }

      // handle actual message
      for (const handler of this.handlers) {
        handler(parsedMsg);
      }

      // send ack
      const ack: TransportMessageAck = {
        from: this.clientId,
        replyTo: parsedMsg.id,
      };

      this.send(ack);
    }
  }

  addMessageListener(handler: (msg: TransportMessage) => void): void {
    this.handlers.add(handler);
  }

  removeMessageListener(handler: (msg: TransportMessage) => void): void {
    this.handlers.delete(handler);
  }

  abstract send(msg: TransportMessage | TransportMessageAck): MessageId;
  abstract close(): Promise<void>;
}
