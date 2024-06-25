import { Connection } from '../session';
import {
  IdentifiedSession,
  SessionConnectingListeners,
  SessionState,
  bestEffortClose,
} from './common';

export class SessionConnecting<
  ConnType extends Connection,
> extends IdentifiedSession {
  readonly state = SessionState.Connecting as const;
  connPromise: Promise<ConnType>;
  listeners: SessionConnectingListeners<ConnType>;

  constructor(
    connPromise: Promise<ConnType>,
    listeners: SessionConnectingListeners<ConnType>,
    ...args: ConstructorParameters<typeof IdentifiedSession>
  ) {
    super(...args);
    this.connPromise = connPromise;
    this.listeners = listeners;

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

  _onStateExit(): void {
    super._onStateExit();
  }

  _onClose(): void {
    super._onClose();

    // close the pending connection if it resolves
    bestEffortClose(this.connPromise);
  }
}
