import { IdentifiedSession, SessionState } from './common';

export interface SessionNoConnectionListeners {
  // timeout related
  onSessionGracePeriodElapsed: () => void;
}

/*
 * A session that is not connected and cannot send or receive messages.
 *
 * Valid transitions:
 * - NoConnection -> Connecting (on connect)
 */
export class SessionNoConnection extends IdentifiedSession {
  readonly state = SessionState.NoConnection as const;
  listeners: SessionNoConnectionListeners;

  gracePeriodTimeout?: ReturnType<typeof setTimeout>;

  constructor(
    listeners: SessionNoConnectionListeners,
    ...args: ConstructorParameters<typeof IdentifiedSession>
  ) {
    super(...args);
    this.listeners = listeners;

    this.gracePeriodTimeout = setTimeout(() => {
      this.listeners.onSessionGracePeriodElapsed();
    }, this.options.sessionDisconnectGraceMs);
  }

  _handleClose(): void {
    super._handleClose();
  }

  _handleStateExit(): void {
    super._handleStateExit();

    if (this.gracePeriodTimeout) {
      clearTimeout(this.gracePeriodTimeout);
      this.gracePeriodTimeout = undefined;
    }
  }
}
