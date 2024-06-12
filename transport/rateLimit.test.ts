import {
  LeakyBucketRateLimit,
  ConnectionRetryOptions,
} from '../transport/rateLimit';
import { describe, test, expect, vi } from 'vitest';

describe('LeakyBucketRateLimit', () => {
  const options: ConnectionRetryOptions = {
    attemptBudgetCapacity: 10,
    budgetRestoreIntervalMs: 1000,
    baseIntervalMs: 100,
    maxJitterMs: 50,
    maxBackoffMs: 5000,
  };

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
    const rateLimit = new LeakyBucketRateLimit(options);
    const user = 'user1';
    rateLimit.consumeBudget(user);
    rateLimit.consumeBudget(user);
    expect(rateLimit.getBudgetConsumed(user)).toBe(2);

    // Advanding time before startRestoringBudget should be noop
    vi.advanceTimersByTime(options.budgetRestoreIntervalMs);
    expect(rateLimit.getBudgetConsumed(user)).toBe(2);

    rateLimit.startRestoringBudget(user);
    expect(rateLimit.getBudgetConsumed(user)).toBe(2);
    vi.advanceTimersByTime(options.budgetRestoreIntervalMs);
    expect(rateLimit.getBudgetConsumed(user)).toBe(1);
  });

  test('stops restoring budget when we consume budget again', () => {
    const rateLimit = new LeakyBucketRateLimit(options);
    const user = 'user1';
    rateLimit.consumeBudget(user);
    rateLimit.consumeBudget(user);
    expect(rateLimit.getBudgetConsumed(user)).toBe(2);

    rateLimit.startRestoringBudget(user);
    expect(rateLimit.getBudgetConsumed(user)).toBe(2);

    rateLimit.consumeBudget(user);
    expect(rateLimit.getBudgetConsumed(user)).toBe(3);
    vi.advanceTimersByTime(options.budgetRestoreIntervalMs);
    expect(rateLimit.getBudgetConsumed(user)).toBe(3);
  });

  test('respects maximum backoff time', () => {
    const maxBackoffMs = 50;
    const rateLimit = new LeakyBucketRateLimit({ ...options, maxBackoffMs });
    const user = 'user1';

    rateLimit.consumeBudget(user);

    expect(rateLimit.getBackoffMs(user)).toBeLessThanOrEqual(
      maxBackoffMs + options.maxJitterMs,
    );
    expect(rateLimit.getBackoffMs(user)).toBeGreaterThanOrEqual(maxBackoffMs);
  });

  test('backoff increases', () => {
    const rateLimit = new LeakyBucketRateLimit(options);
    const user = 'user1';

    rateLimit.consumeBudget(user);
    const backoffMs1 = rateLimit.getBackoffMs(user);
    rateLimit.consumeBudget(user);
    const backoffMs2 = rateLimit.getBackoffMs(user);
    expect(backoffMs2).toBeGreaterThan(backoffMs1);
    rateLimit.consumeBudget(user);
    const backoffMs3 = rateLimit.getBackoffMs(user);
    expect(backoffMs3).toBeGreaterThan(backoffMs2);
  });

  test('reports remaining budget correctly', () => {
    const maxAttempts = 3;
    const rateLimit = new LeakyBucketRateLimit({
      ...options,
      attemptBudgetCapacity: maxAttempts,
    });
    const user = 'user1';

    expect(rateLimit.hasBudget(user)).toBe(true);
    rateLimit.consumeBudget(user);

    expect(rateLimit.hasBudget(user)).toBe(true);
    rateLimit.consumeBudget(user);

    expect(rateLimit.hasBudget(user)).toBe(true);
    rateLimit.consumeBudget(user);

    expect(rateLimit.hasBudget(user)).toBe(false);
    rateLimit.consumeBudget(user);
  });
});
