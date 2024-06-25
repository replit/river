import {
  IdentifiedSession,
  SessionNoConnectionListeners,
  SessionState,
} from './common';

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

  _onClose(): void {
    super._onClose();
  }

  _onStateExit(): void {
    super._onStateExit();

    if (this.gracePeriodTimeout) {
      clearTimeout(this.gracePeriodTimeout);
      this.gracePeriodTimeout = undefined;
    }
  }
}
