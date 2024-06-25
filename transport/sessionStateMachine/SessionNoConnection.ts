import { IdentifiedSession, SessionState } from './common';

export class SessionNoConnection extends IdentifiedSession {
  readonly state = SessionState.NoConnection as const;
}
