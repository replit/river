import { Connection } from '../connection';
import {
  IdentifiedSessionWithGracePeriod,
  IdentifiedSessionWithGracePeriodListeners,
  IdentifiedSessionWithGracePeriodProps,
  SessionState,
} from './common';

export interface SessionConnectingListeners
  extends IdentifiedSessionWithGracePeriodListeners {
  onConnectionEstablished: (conn: Connection) => void;
  onConnectionFailed: (err: unknown) => void;

  // timeout related
  onConnectionTimeout: () => void;
}

export interface SessionConnectingProps<ConnType extends Connection>
  extends IdentifiedSessionWithGracePeriodProps {
  connPromise: Promise<ConnType>;
  listeners: SessionConnectingListeners;
}

/*
 * A session that is connecting but we don't have access to the raw connection yet.
 * See transitions.ts for valid transitions.
 */
export class SessionConnecting<
  ConnType extends Connection,
> extends IdentifiedSessionWithGracePeriod {
  readonly state = SessionState.Connecting as const;
  connPromise: Promise<ConnType>;
  listeners: SessionConnectingListeners;

  connectionTimeout?: ReturnType<typeof setTimeout>;

  constructor(props: SessionConnectingProps<ConnType>) {
    super(props);
    this.connPromise = props.connPromise;
    this.listeners = props.listeners;

    this.connectionTimeout = setTimeout(() => {
      this.listeners.onConnectionTimeout();
    }, this.options.connectionTimeoutMs);

    this.connPromise.then(
      (conn) => {
        if (this._isConsumed) return;
        this.listeners.onConnectionEstablished(conn);
      },
      (err) => {
        if (this._isConsumed) return;
        this.listeners.onConnectionFailed(err);
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

    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = undefined;
    }
  }

  _handleClose(): void {
    // close the pending connection if it resolves
    this.bestEffortClose();
    super._handleClose();
  }
}
