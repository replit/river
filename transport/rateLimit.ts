import { TransportClientId } from './message';

/**
 * Options to control the backoff and retry behavior of the client transport's connection behaviour.
 *
 * River implements exponential backoff with jitter to prevent flooding the server
 * when there's an issue with connection establishment.
 *
 * The backoff is calculated via the following:
 *   backOff = min(jitter + {@link baseIntervalMs} * 2 ^ budget_consumed, {@link maxBackoffMs})
 *
 * We use a leaky bucket rate limit with a budget of {@link attemptBudgetCapacity} reconnection attempts.
 * Budget only starts to restore after a successful handshake at a rate of one budget per {@link budgetRestoreIntervalMs}.
 */
export interface ConnectionRetryOptions {
  /**
   * The base interval to wait before retrying a connection.
   */
  baseIntervalMs: number;

  /**
   * The maximum random jitter to add to the total backoff time.
   */
  maxJitterMs: number;

  /**
   * The maximum amount of time to wait before retrying a connection.
   * This does not include the jitter.
   */
  maxBackoffMs: number;

  /**
   * The max number of times to attempt a connection before a successful handshake.
   * This persists across connections but starts restoring budget after a successful handshake.
   * The restoration interval depends on {@link budgetRestoreIntervalMs}
   */
  attemptBudgetCapacity: number;

  /**
   * After a successful connection attempt, how long to wait before we restore a single budget.
   */
  budgetRestoreIntervalMs: number;
}

export class LeakyBucketRateLimit {
  private budgetConsumed: Map<TransportClientId, number>;
  private intervalHandles: Map<
    TransportClientId,
    ReturnType<typeof setInterval>
  >;
  private readonly options: ConnectionRetryOptions;

  constructor(options: ConnectionRetryOptions) {
    this.options = options;
    this.budgetConsumed = new Map();
    this.intervalHandles = new Map();
  }

  getBackoffMs(user: TransportClientId) {
    if (!this.budgetConsumed.has(user)) return 0;

    const exponent = Math.max(0, this.getBudgetConsumed(user) - 1);
    const jitter = Math.floor(Math.random() * this.options.maxJitterMs);
    const backoffMs = Math.min(
      this.options.baseIntervalMs * 2 ** exponent,
      this.options.maxBackoffMs,
    );

    return backoffMs + jitter;
  }

  get totalBudgetRestoreTime() {
    return (
      this.options.budgetRestoreIntervalMs * this.options.attemptBudgetCapacity
    );
  }

  consumeBudget(user: TransportClientId) {
    // If we're consuming again, let's ensure that we're not leaking
    this.stopLeak(user);
    this.budgetConsumed.set(user, this.getBudgetConsumed(user) + 1);
  }

  getBudgetConsumed(user: TransportClientId) {
    return this.budgetConsumed.get(user) ?? 0;
  }

  hasBudget(user: TransportClientId) {
    return this.getBudgetConsumed(user) < this.options.attemptBudgetCapacity;
  }

  startRestoringBudget(user: TransportClientId) {
    if (this.intervalHandles.has(user)) {
      return;
    }

    const restoreBudgetForUser = () => {
      const currentBudget = this.budgetConsumed.get(user);
      if (!currentBudget) {
        this.stopLeak(user);
        return;
      }

      const newBudget = currentBudget - 1;
      if (newBudget === 0) {
        this.budgetConsumed.delete(user);
        return;
      }

      this.budgetConsumed.set(user, newBudget);
    };

    const intervalHandle = setInterval(
      restoreBudgetForUser,
      this.options.budgetRestoreIntervalMs,
    );

    this.intervalHandles.set(user, intervalHandle);
  }

  private stopLeak(user: TransportClientId) {
    if (!this.intervalHandles.has(user)) {
      return;
    }

    clearInterval(this.intervalHandles.get(user));
    this.intervalHandles.delete(user);
  }

  close() {
    for (const user of this.intervalHandles.keys()) {
      this.stopLeak(user);
    }
  }
}
