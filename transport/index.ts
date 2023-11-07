import { OpaqueTransportMessage } from './message';
import { Transport } from './types';

// re-export
export { Transport } from './types';
export {
  TransportMessageSchema,
  OpaqueTransportMessageSchema,
  TransportAckSchema,
  msg,
  payloadToTransportMessage,
  ack,
  reply,
} from './message';
export type {
  TransportMessage,
  MessageId,
  OpaqueTransportMessage,
  TransportClientId,
  TransportMessageAck,
} from './message';

export async function waitForMessage(
  t: Transport,
  filter?: (msg: OpaqueTransportMessage) => boolean,
) {
  return new Promise((resolve, _reject) => {
    function onMessage(msg: OpaqueTransportMessage) {
      if (!filter || filter?.(msg)) {
        resolve(msg.payload);
        t.removeMessageListener(onMessage);
      }
    }

    t.addMessageListener(onMessage);
  });
}
