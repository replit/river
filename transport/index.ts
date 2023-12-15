import { Err } from '../router';
import { UNEXPECTED_DISCONNECT } from '../router/result';
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
 * Waits for a message on the transport.
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
      cleanup();
      resolve(
        Err({
          code: UNEXPECTED_DISCONNECT,
          message: `${from} unexpectedly disconnected`,
        }),
      );
    });

    function cleanup() {
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

    t.addEventListener('connectionStatus', connectionTimeout);
    t.addEventListener('message', onMessage);
  });
}

export const CONNECTION_GRACE_PERIOD_MS = 5_000; // 5s
export function rejectAfterDisconnectGrace(
  from: TransportClientId,
  cb: () => void,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined = undefined;
  return (evt: EventMap['connectionStatus']) => {
    if (evt.status === 'connect' && evt.conn.connectedTo === from) {
      clearTimeout(timeout);
      timeout = undefined;
    }

    if (evt.status === 'disconnect' && evt.conn.connectedTo === from) {
      timeout = setTimeout(cb, CONNECTION_GRACE_PERIOD_MS);
    }
  };
}
