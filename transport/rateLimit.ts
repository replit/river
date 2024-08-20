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
  private budgetConsumed: number;
  private intervalHandle?: ReturnType<typeof setInterval>;
  private readonly options: ConnectionRetryOptions;

  constructor(options: ConnectionRetryOptions) {
    this.options = options;
    this.budgetConsumed = 0;
  }

  getBackoffMs() {
    if (this.getBudgetConsumed() === 0) {
      return 0;
    }

    const exponent = Math.max(0, this.getBudgetConsumed() - 1);
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

  consumeBudget() {
    // If we're consuming again, let's ensure that we're not leaking
    this.stopLeak();
    this.budgetConsumed = this.getBudgetConsumed() + 1;
  }

  getBudgetConsumed() {
    return this.budgetConsumed;
  }

  hasBudget() {
    return this.getBudgetConsumed() < this.options.attemptBudgetCapacity;
  }

  startRestoringBudget() {
    if (this.intervalHandle) {
      return;
    }

    const restoreBudgetForUser = () => {
      const currentBudget = this.budgetConsumed;
      if (!currentBudget) {
        this.stopLeak();

        return;
      }

      const newBudget = currentBudget - 1;
      if (newBudget === 0) {
        return;
      }

      this.budgetConsumed = newBudget;
    };

    this.intervalHandle = setInterval(
      restoreBudgetForUser,
      this.options.budgetRestoreIntervalMs,
    );
  }

  private stopLeak() {
    if (!this.intervalHandle) {
      return;
    }

    clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  close() {
    this.stopLeak();
  }
}
