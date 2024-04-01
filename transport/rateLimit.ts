import { TransportClientId } from './message';

export interface LeakBucketLimitOptions {
  maxBurst: number;
  leakIntervalMs: number;
  baseIntervalMs: number;
  jitterMs: number;
}

export class LeakyBucketRateLimit {
  budgetConsumed: Map<TransportClientId, number>;
  intervalHandle: ReturnType<typeof setInterval>;
  readonly options: LeakBucketLimitOptions;

  constructor(options: LeakBucketLimitOptions) {
    this.options = options;
    this.budgetConsumed = new Map();

    // start leaking
    this.intervalHandle = setInterval(() => {
      for (const [user, budgetConsumed] of this.budgetConsumed.entries()) {
        const newBudget = budgetConsumed - 1;
        if (newBudget === 0) {
          this.budgetConsumed.delete(user);
        } else {
          this.budgetConsumed.set(user, newBudget);
        }
      }
    }, this.options.leakIntervalMs);
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
    this.budgetConsumed.set(user, this.getBudgetConsumed(user) + 1);
  }

  getBudgetConsumed(user: TransportClientId) {
    return this.budgetConsumed.get(user) ?? 0;
  }

  close() {
    clearInterval(this.intervalHandle);
  }
}
