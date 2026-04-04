export { SessionState, type SessionId } from './common';
export { Session } from '../session';
export type { Session as SessionWaitingForHandshake } from '../session';
export type { Session as SessionConnecting } from '../session';
export type {
  Session as SessionNoConnection,
} from '../session';
export type { Session as SessionHandshaking } from '../session';
export type { Session as SessionConnected } from '../session';

// Re-export listener type for backward compat
export type { IdentifiedSessionWithGracePeriodListeners as SessionNoConnectionListeners } from './common';

// Session union types (now just Session since there's one class)
export type { Session as ClientSession } from '../session';
export type { Session as ServerSession } from '../session';
