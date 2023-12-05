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

/**
 * Abstract base for a transport layer for communication between nodes in a River network.
 * Any River transport methods need to implement this interface.
 * @abstract
 */
export abstract class Transport {
  /**
   * The {@link Codec} used to encode and decode messages.
   */
  codec: Codec;

  /**
   * The client ID of this transport.
   */
  clientId: TransportClientId;

  /**
   * The set of message handlers registered with this transport.
   */
  handlers: Set<(msg: OpaqueTransportMessage) => void>;

  // TODO; we can do much better here on retry (maybe resending the sendBuffer on fixed interval)
  /**
   * The buffer of messages that have been sent but not yet acknowledged.
   */
  sendBuffer: Map<MessageId, OpaqueTransportMessage>;

  /**
   * Creates a new Transport instance.
   * @param codec The codec used to encode and decode messages.
   * @param clientId The client ID of this transport.
   */
  constructor(codec: Codec, clientId: TransportClientId) {
    this.handlers = new Set();
    this.sendBuffer = new Map();
    this.codec = codec;
    this.clientId = clientId;
  }

  /**
   * Called when a message is received by this transport.
   * You generally shouldn't need to override this in downstream transport implementations.
   * @param msg The received message.
   */
  onMessage(msg: Uint8Array, cb?: (msg: OpaqueTransportMessage) => void) {
    const parsedMsg = this.codec.fromBuffer(msg);

    if (parsedMsg === null) {
      log?.warn(
        `${this.clientId} -- received malformed msg: ${new TextDecoder().decode(
          msg,
        )}`,
      );
      return;
    }

    let stringifiedMessage;
    if (log) {
      stringifiedMessage = JSON.stringify(parsedMsg);
    }

    if (
      Value.Check(TransportAckSchema, parsedMsg) &&
      isAck(parsedMsg.controlFlags)
    ) {
      // process ack
      log?.info(`${this.clientId} -- received ack: ${stringifiedMessage}`);
      if (this.sendBuffer.has(parsedMsg.payload.ack)) {
        this.sendBuffer.delete(parsedMsg.payload.ack);
      }
    } else if (Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
      // regular river message
      log?.info(`${this.clientId} -- received msg: ${stringifiedMessage}`);

      // ignore if not for us
      if (parsedMsg.to !== this.clientId && parsedMsg.to !== 'broadcast') {
        return;
      }

      // handle actual message
      cb?.(parsedMsg);
      for (const handler of this.handlers) {
        handler(parsedMsg);
      }

      const ackMsg = reply(parsedMsg, { ack: parsedMsg.id });
      ackMsg.controlFlags = ControlFlags.AckBit;
      ackMsg.from = this.clientId;

      this.send(ackMsg);
    } else {
      log?.warn(
        `${this.clientId} -- received invalid transport msg: ${stringifiedMessage}`,
      );
    }
  }

  /**
   * Adds a message listener to this transport.
   * @param handler The message handler to add.
   */
  addMessageListener(handler: (msg: OpaqueTransportMessage) => void): void {
    this.handlers.add(handler);
  }

  /**
   * Removes a message listener from this transport.
   * @param handler The message handler to remove.
   */
  removeMessageListener(handler: (msg: OpaqueTransportMessage) => void): void {
    this.handlers.delete(handler);
  }

  abstract send(msg: OpaqueTransportMessage): MessageId;
  abstract close(): Promise<void>;
}
