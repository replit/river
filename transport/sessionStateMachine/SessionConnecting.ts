import { Connection } from '../connection';
import { IdentifiedSession, SessionState } from './common';

export interface SessionConnectingListeners<ConnType extends Connection> {
  onConnectionEstablished: (conn: ConnType) => void;
  onConnectionFailed: (err: unknown) => void;

  // timeout related
  onConnectionTimeout: () => void;
}

/*
 * A session that is connecting but we don't have access to the raw connection
 * yet.
 *
 * Valid transitions:
 * - Connecting -> NoConnection (timeout)
 * - Connecting -> Handshaking (on connection established)
 */
export class SessionConnecting<
  ConnType extends Connection,
> extends IdentifiedSession {
  readonly state = SessionState.Connecting as const;
  connPromise: Promise<ConnType>;
  listeners: SessionConnectingListeners<ConnType>;

  connectionTimeout: ReturnType<typeof setTimeout>;

  constructor(
    connPromise: Promise<ConnType>,
    listeners: SessionConnectingListeners<ConnType>,
    ...args: ConstructorParameters<typeof IdentifiedSession>
  ) {
    super(...args);
    this.connPromise = connPromise;
    this.listeners = listeners;

    this.connectionTimeout = setTimeout(() => {
      listeners.onConnectionTimeout();
    }, this.options.connectionTimeoutMs);

    connPromise.then(
      (conn) => {
        if (this._isConsumed) return;
        listeners.onConnectionEstablished(conn);
      },
      (err) => {
        if (this._isConsumed) return;
        listeners.onConnectionFailed(err);
      },
    );
  }

  // close a pending connection if it resolves, ignore errors if the promise
  // ends up rejected anyways
  bestEffortClose() {
    void this.connPromise
      .then((conn) => conn.close())
      .catch(() => {
        // ignore errors
      });
  }

  _handleStateExit(): void {
    super._handleStateExit();
    clearTimeout(this.connectionTimeout);
  }

  _handleClose(): void {
    // close the pending connection if it resolves
    this.bestEffortClose();
    super._handleClose();
  }
}
