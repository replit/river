import {
  IdentifiedSessionWithGracePeriod,
  IdentifiedSessionWithGracePeriodListeners,
  IdentifiedSessionWithGracePeriodProps,
  SessionState,
} from './common';

export type SessionNoConnectionListeners =
  IdentifiedSessionWithGracePeriodListeners;

export type SessionNoConnectionProps = IdentifiedSessionWithGracePeriodProps;

/*
 * A session that is not connected and cannot send or receive messages.
 * See transitions.ts for valid transitions.
 */
export class SessionNoConnection extends IdentifiedSessionWithGracePeriod {
  readonly state = SessionState.NoConnection as const;

  _handleClose(): void {
    super._handleClose();
  }

  _handleStateExit(): void {
    super._handleStateExit();
  }
}
