import { TransportClientId } from './message';

export interface LeakBucketLimitOptions {
  maxBurst: number;
  leakIntervalMs: number;
  baseIntervalMs: number;
  jitterMs: number;
}

export class LeakyBucketRateLimit {
  private budgetConsumed: Map<TransportClientId, number>;
  private intervalHandles: Map<
    TransportClientId,
    ReturnType<typeof setInterval>
  >;
  private readonly options: LeakBucketLimitOptions;

  constructor(options: LeakBucketLimitOptions) {
    this.options = options;
    this.budgetConsumed = new Map();
    this.intervalHandles = new Map();
  }

  get drainageTimeMs() {
    return this.options.leakIntervalMs * this.options.maxBurst;
  }

  getBackoffMs(user: TransportClientId) {
    if (!this.budgetConsumed.has(user)) return 0;

    const exponent = Math.max(0, this.getBudgetConsumed(user) - 1);
    const jitter = Math.floor(Math.random() * this.options.jitterMs);
    const backoffMs = this.options.baseIntervalMs * 2 ** exponent + jitter;
    return backoffMs;
  }

  consumeBudget(user: TransportClientId) {
    // If we're consuming again, let's ensure that we're not leaking
    this.stopLeak(user);
    this.budgetConsumed.set(user, this.getBudgetConsumed(user) + 1);
  }

  getBudgetConsumed(user: TransportClientId) {
    return this.budgetConsumed.get(user) ?? 0;
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
      } else {
        this.budgetConsumed.set(user, newBudget);
      }
    }, this.options.leakIntervalMs);

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
