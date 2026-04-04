/**
 * Re-exports from the new unified Session module.
 * The old class hierarchy (StateMachineState → CommonSession → IdentifiedSession →
 * IdentifiedSessionWithGracePeriod → SessionXxx) has been replaced by a single
 * Session class. These re-exports exist for backward compatibility.
 */
export {
  SessionState,
  Session,
  type SessionId,
  type SessionOptions,
  type SessionProps,
} from '../session';
export type { Session as IdentifiedSession } from '../session';
export type { Session as CommonSession } from '../session';
export type { Session as IdentifiedSessionWithGracePeriod } from '../session';
export type { SessionProps as CommonSessionProps } from '../session';
export type { SessionProps as IdentifiedSessionProps } from '../session';
export type { SessionProps as IdentifiedSessionWithGracePeriodProps } from '../session';

// Backward compat: InheritedProperties was Pick<IdentifiedSession, ...>
export type InheritedProperties = import('../session').Session;

// Backward compat: listener interfaces (no longer used internally)
export interface IdentifiedSessionListeners {
  onMessageSendFailure?: (
    msg: import('../message').PartialTransportMessage & { seq: number },
    reason: string,
  ) => void;
}

export interface IdentifiedSessionWithGracePeriodListeners
  extends IdentifiedSessionListeners {
  onSessionGracePeriodElapsed?: () => void;
}

// Backward compat: ERR_CONSUMED constant
export const ERR_CONSUMED =
  'session state has been consumed and is no longer valid';
