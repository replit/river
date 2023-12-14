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
    const connectionTimeout = rejectAfterDisconnectGrace(from, () => {
      console.log('CLEANUP TIMEOUT');
      cleanup();
      resolve(
        Err({
          code: UNCAUGHT_ERROR,
          message: `${from} unexpectedly disconnected`,
        }),
      );
    });

    function cleanup() {
      console.log('CLEANUP');
      t.removeEventListener('message', onMessage);
      t.removeEventListener('connectionStatus', connectionTimeout);
    }

    function onMessage(msg: OpaqueTransportMessage) {
      if (!filter || filter?.(msg)) {
        cleanup();
        resolve(msg.payload);
      } else if (rejectMismatch) {
        reject(new Error('message didnt match the filter'));
      }
    }

    console.log('WAITING ON NEW MESSAGE');
    t.addEventListener('connectionStatus', connectionTimeout);
    t.addEventListener('message', onMessage);
  });
}

export const CONNECTION_GRACE_PERIOD_MS = 150; // 5s
export function rejectAfterDisconnectGrace(
  from: TransportClientId,
  cb: () => void,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined = undefined;
  return (evt: EventMap['connectionStatus']) => {
    if (evt.status === 'connect' && evt.conn.connectedTo === from) {
      console.log('CONNECT');
      clearTimeout(timeout);
      timeout = undefined;
    }

    if (evt.status === 'disconnect' && evt.conn.connectedTo === from) {
      console.log('DISCONNECT');
      // cb()
      timeout = setTimeout(() => {
        // we never hit here
        console.log('INSIDE TIMEOUT');
        cb();
      }, CONNECTION_GRACE_PERIOD_MS);
    }
  };
}
