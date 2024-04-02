import { TransportClientId } from './message';

/**
 * Options to control the backoff and retry behavior of the transport's connection.
 *
 * River implements exponential backoff with jitter to prevent flooding the server
 * when there's an issue.
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
   * This does not include the jitter
   */
  maxBackoffMs: number;
  /**
   * The maximum number of times to retry a connection before giving up.
   * This persists across connections but starts reseting after every succesful
   * connection, the restoration period depends on {@link Connection.retryBudgetRestoreIntervalMs}
   */
  maxAttempts: number;
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

  consumeBudget(user: TransportClientId) {
    // If we're consuming again, let's ensure that we're not leaking
    this.stopLeak(user);
    this.budgetConsumed.set(user, this.getBudgetConsumed(user) + 1);
  }

  getBudgetConsumed(user: TransportClientId) {
    return this.budgetConsumed.get(user) ?? 0;
  }

  hasBudget(user: TransportClientId) {
    return this.getBudgetConsumed(user) < this.options.maxAttempts;
  }

  startRestoringBudget(user: TransportClientId) {
    if (this.intervalHandles.has(user)) {
      return;
    }

    const intervalHandle = setInterval(() => {
      const currentBudget = this.budgetConsumed.get(user);
      if (!currentBudget) {
        // Mostly appeasing typescript
        this.stopLeak(user);

        return;
      }

      const newBudget = currentBudget - 1;
      if (newBudget === 0) {
        this.budgetConsumed.delete(user);

        return;
      }

      this.budgetConsumed.set(user, newBudget);
    }, this.options.budgetRestoreIntervalMs);

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
