import { Err, UNCAUGHT_ERROR } from '../router';
import { EventMap } from './events';
import { OpaqueTransportMessage, TransportClientId } from './message';
import { Transport, Connection } from './transport';

// re-export
export { Transport, Connection } from './transport';
export {
  TransportMessageSchema,
  OpaqueTransportMessageSchema,
  msg,
  reply,
} from './message';
export type {
  TransportMessage,
  MessageId,
  OpaqueTransportMessage,
  TransportClientId,
  isStreamOpen,
  isStreamClose,
} from './message';

/**
 * Waits for a message from the transport.
 * @param {Transport} t - The transport to listen to.
 * @param filter - An optional filter function to apply to the received messages.
 * @returns A promise that resolves with the payload of the first message that passes the filter.
 */
export async function waitForMessage(
  t: Transport<Connection>,
  from: TransportClientId,
  filter?: (msg: OpaqueTransportMessage) => boolean,
  rejectMismatch?: boolean,
) {
  return new Promise((resolve, reject) => {
    function onMessage(msg: OpaqueTransportMessage) {
      if (!filter || filter?.(msg)) {
        resolve(msg.payload);
        t.removeEventListener('message', onMessage);
        t.removeEventListener('connectionStatus', onDisconnect);
      } else if (rejectMismatch) {
        reject(new Error('message didnt match the filter'));
      }
    }

    function onDisconnect(evt: EventMap['connectionStatus']) {
      if (evt.status === 'disconnect' && evt.conn.connectedTo === from) {
        t.removeEventListener('message', onMessage);
        t.removeEventListener('connectionStatus', onDisconnect);

        resolve(
          Err({
            code: UNCAUGHT_ERROR,
            message: `${from} unexpectedly disconnected`,
          }),
        );
      }
    }

    t.addEventListener('connectionStatus', onDisconnect);
    t.addEventListener('message', onMessage);
  });
}
