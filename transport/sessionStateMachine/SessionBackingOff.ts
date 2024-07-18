import {
  IdentifiedSessionWithGracePeriod,
  IdentifiedSessionWithGracePeriodListeners,
  IdentifiedSessionWithGracePeriodProps,
  SessionState,
} from './common';

export interface SessionBackingOffListeners
  extends IdentifiedSessionWithGracePeriodListeners {
  onBackoffFinished: () => void;
}

export interface SessionBackingOffProps
  extends IdentifiedSessionWithGracePeriodProps {
  backoffMs: number;
  listeners: SessionBackingOffListeners;
}

/*
 * A session that is backing off before attempting to connect.
 * See transitions.ts for valid transitions.
 */
export class SessionBackingOff extends IdentifiedSessionWithGracePeriod {
  readonly state = SessionState.BackingOff as const;
  listeners: SessionBackingOffListeners;

  backoffTimeout?: ReturnType<typeof setTimeout>;

  constructor(props: SessionBackingOffProps) {
    super(props);
    this.listeners = props.listeners;

    this.backoffTimeout = setTimeout(() => {
      this.listeners.onBackoffFinished();
    }, props.backoffMs);
  }

  _handleClose(): void {
    super._handleClose();
  }

  _handleStateExit(): void {
    super._handleStateExit();

    if (this.backoffTimeout) {
      clearTimeout(this.backoffTimeout);
      this.backoffTimeout = undefined;
    }
  }
}
