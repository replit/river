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

export type TransportStatus = 'open' | 'closed' | 'destroyed';

/**
 * Abstract base for a transport layer for communication between nodes in a River network.
 * Any River transport methods need to implement this interface.
 * @abstract
 */
export abstract class Transport {
  /**
   * A flag indicating whether the transport has been destroyed.
   * A destroyed transport will not attempt to reconnect and cannot be used again.
   */
  state: TransportStatus;

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
  messageHandlers: Set<(msg: OpaqueTransportMessage) => void>;

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
    this.messageHandlers = new Set();
    this.sendBuffer = new Map();
    this.codec = codec;
    this.clientId = clientId;
    this.state = 'open';
  }

  /**
   * Handles a message received by this transport. Thin wrapper around {@link handleMsg} and {@link parseMsg}.
   * @param msg The message to handle.
   */
  onMessage(msg: Uint8Array) {
    return this.handleMsg(this.parseMsg(msg));
  }

  /**
   * Parses a message from a Uint8Array into a {@link OpaqueTransportMessage}.
   * @param msg The message to parse.
   * @returns The parsed message, or null if the message is malformed or invalid.
   */
  parseMsg(msg: Uint8Array): OpaqueTransportMessage | null {
    const parsedMsg = this.codec.fromBuffer(msg);

    if (parsedMsg === null) {
      const decodedBuffer = new TextDecoder().decode(msg);
      log?.warn(`${this.clientId} -- received malformed msg: ${decodedBuffer}`);
      return null;
    }

    if (Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
      return parsedMsg;
    } else {
      log?.warn(
        `${this.clientId} -- received invalid msg: ${JSON.stringify(msg)}`,
      );
      return null;
    }
  }

  /**
   * Called when a message is received by this transport.
   * You generally shouldn't need to override this in downstream transport implementations.
   * @param msg The received message.
   */
  handleMsg(msg: OpaqueTransportMessage | null) {
    if (!msg) {
      return;
    }

    if (isAck(msg.controlFlags) && Value.Check(TransportAckSchema, msg)) {
      // process ack
      log?.info(`${this.clientId} -- received ack: ${JSON.stringify(msg)}`);
      if (this.sendBuffer.has(msg.payload.ack)) {
        this.sendBuffer.delete(msg.payload.ack);
      }
    } else {
      // regular river message
      log?.info(`${this.clientId} -- received msg: ${JSON.stringify(msg)}`);
      if (msg.to !== this.clientId) {
        return;
      }

      for (const handler of this.messageHandlers) {
        handler(msg);
      }

      const ackMsg = reply(msg, { ack: msg.id });
      ackMsg.controlFlags = ControlFlags.AckBit;
      ackMsg.from = this.clientId;

      this.send(ackMsg);
    }
  }

  /**
   * Adds a message listener to this transport.
   * @param handler The message handler to add.
   */
  addMessageListener(handler: (msg: OpaqueTransportMessage) => void): void {
    this.messageHandlers.add(handler);
  }

  /**
   * Removes a message listener from this transport.
   * @param handler The message handler to remove.
   */
  removeMessageListener(handler: (msg: OpaqueTransportMessage) => void): void {
    this.messageHandlers.delete(handler);
  }

  abstract send(msg: OpaqueTransportMessage): MessageId;
  abstract close(): Promise<void>;
}
