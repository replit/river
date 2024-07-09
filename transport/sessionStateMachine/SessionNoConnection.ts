import {
  IdentifiedSession,
  IdentifiedSessionProps,
  SessionState,
} from './common';

export interface SessionNoConnectionListeners {
  // timeout related
  onSessionGracePeriodElapsed: () => void;
}

export interface SessionNoConnectionProps extends IdentifiedSessionProps {
  listeners: SessionNoConnectionListeners;
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

  constructor(props: SessionNoConnectionProps) {
    super(props);
    this.listeners = props.listeners;

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
