import { ClientTransport } from '../transport/client';
import { Connection } from '../transport/connection';
import {
  CustomHandshakeErrorCodeSchema,
  TransportClientId,
} from '../transport/message';
import { createPromiseWithResolvers } from '../transport/promises';
import { SessionState } from '../transport/sessionStateMachine/common';
import { MAX_TIMER_DELAY_MS } from '../transport/transport';

export interface ResendRefusedCallsOptions {
  maxResends: number;
  newSessionWaitMs: number;
}

export function validateResendLimits(
  limits: ResendRefusedCallsOptions | undefined,
): void {
  if (
    limits &&
    (!Number.isSafeInteger(limits.maxResends) ||
      !Number.isFinite(limits.newSessionWaitMs) ||
      limits.newSessionWaitMs < 0 ||
      limits.newSessionWaitMs > MAX_TIMER_DELAY_MS)
  ) {
    throw new RangeError('Invalid resendRefusedCalls limits');
  }
}

export function waitForNewSession<
  RejectionCodeSchema extends CustomHandshakeErrorCodeSchema,
>(
  transport: ClientTransport<Connection, RejectionCodeSchema>,
  serverId: TransportClientId,
  sessionId: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      transport.removeEventListener('sessionTransition', check);
      transport.removeEventListener('transportStatus', check);
      signal?.removeEventListener('abort', aborted);
      resolve(ready);
    };
    const aborted = () => finish(false);
    const check = () => {
      const session = transport.sessions.get(serverId);
      if (signal?.aborted === true || transport.getStatus() === 'closed') {
        finish(false);
      } else if (
        session &&
        session.id !== sessionId &&
        session.state === SessionState.Connected
      ) {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    transport.addEventListener('sessionTransition', check);
    transport.addEventListener('transportStatus', check);
    signal?.addEventListener('abort', aborted, { once: true });
    check();
  });
}

export class DrainController {
  private state:
    | { status: 'accepting' }
    | { status: 'draining'; promise: Promise<void>; finish: () => void } = {
    status: 'accepting',
  };

  constructor(
    private readonly hasPendingResponse: () => boolean,
    private readonly closeTransport: () => void,
  ) {}

  get accepting(): boolean {
    return this.state.status === 'accepting';
  }

  responseFinished(): void {
    if (this.state.status === 'draining' && !this.hasPendingResponse()) {
      this.state.finish();
    }
  }

  drain({ budgetMs }: { budgetMs: number }): Promise<void> {
    if (
      !Number.isFinite(budgetMs) ||
      budgetMs < 0 ||
      budgetMs > MAX_TIMER_DELAY_MS
    ) {
      throw new RangeError('budgetMs must be between 0 and 2147483647');
    }
    switch (this.state.status) {
      case 'draining':
        return this.state.promise;
      case 'accepting': {
        const { promise: waiting, resolve: finish } =
          createPromiseWithResolvers<void>();
        const timer = setTimeout(finish, budgetMs);
        const promise = waiting.then(() => {
          clearTimeout(timer);
          this.closeTransport();
        });
        this.state = { status: 'draining', promise, finish };
        this.responseFinished();

        return promise;
      }
    }
  }
}
