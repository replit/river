import {
  LeakyBucketRateLimit,
  LeakBucketLimitOptions,
} from '../transport/rateLimit';
import { describe, test, expect, vi } from 'vitest';

describe('LeakyBucketRateLimit', () => {
  const options: LeakBucketLimitOptions = {
    maxBurst: 10,
    leakIntervalMs: 1000,
    baseIntervalMs: 100,
    jitterMs: 50,
  };

  test('should calculate drainage time correctly', () => {
    const rateLimit = new LeakyBucketRateLimit(options);
    expect(rateLimit.drainageTimeMs).toBe(
      options.leakIntervalMs * options.maxBurst,
    );
  });

  test('should return 0 backoff time for new user', () => {
    const rateLimit = new LeakyBucketRateLimit(options);
    const user = 'user1';
    const backoffMs = rateLimit.getBackoffMs(user);
    expect(backoffMs).toBe(0);
  });

  test('should return 0 budget consumed for new user', () => {
    const rateLimit = new LeakyBucketRateLimit(options);
    const user = 'user1';
    const budgetConsumed = rateLimit.getBudgetConsumed(user);
    expect(budgetConsumed).toBe(0);
  });

  test('should consume budget correctly', () => {
    const rateLimit = new LeakyBucketRateLimit(options);
    const user = 'user1';
    rateLimit.consumeBudget(user);
    expect(rateLimit.getBudgetConsumed(user)).toBe(1);
  });

  test('keeps growing until startRestoringBudget', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rateLimit = new LeakyBucketRateLimit(options);
    const user = 'user1';
    rateLimit.consumeBudget(user);
    rateLimit.consumeBudget(user);
    expect(rateLimit.getBudgetConsumed(user)).toBe(2);

    // Advanding time before startRestoringBudget should be noop
    vi.advanceTimersByTime(options.leakIntervalMs);
    expect(rateLimit.getBudgetConsumed(user)).toBe(2);

    rateLimit.startRestoringBudget(user);
    vi.advanceTimersByTime(options.leakIntervalMs);
    expect(rateLimit.getBudgetConsumed(user)).toBe(1);
    vi.advanceTimersByTime(options.leakIntervalMs);
    expect(rateLimit.getBudgetConsumed(user)).toBe(0);
  });

  test('stops restoring budget when we consume budget again', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rateLimit = new LeakyBucketRateLimit(options);
    const user = 'user1';
    rateLimit.consumeBudget(user);
    rateLimit.consumeBudget(user);
    expect(rateLimit.getBudgetConsumed(user)).toBe(2);

    rateLimit.startRestoringBudget(user);
    vi.advanceTimersByTime(options.leakIntervalMs);
    expect(rateLimit.getBudgetConsumed(user)).toBe(1);

    rateLimit.consumeBudget(user);
    expect(rateLimit.getBudgetConsumed(user)).toBe(2);
    vi.advanceTimersByTime(options.leakIntervalMs);
    expect(rateLimit.getBudgetConsumed(user)).toBe(2);
  });
});
