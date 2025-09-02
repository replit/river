import {
  LeakyBucketRateLimit,
  ConnectionRetryOptions,
} from '../transport/rateLimit';
import { describe, test, expect, vi } from 'vitest';
import { defaultClientTransportOptions } from './options';

describe('LeakyBucketRateLimit', () => {
  const options: ConnectionRetryOptions = {
    ...defaultClientTransportOptions,
    attemptBudgetCapacity: 10,
    budgetRestoreIntervalMs: 1000,
    baseIntervalMs: 100,
    maxJitterMs: 50,
    maxBackoffMs: 5000,
  };

  test('should return 0 backoff time for new user', () => {
    const rateLimit = new LeakyBucketRateLimit(options);
    const backoffMs = rateLimit.getBackoffMs();
    expect(backoffMs).toBe(0);
  });

  test('should return 0 budget consumed for new user', () => {
    const rateLimit = new LeakyBucketRateLimit(options);
    const budgetConsumed = rateLimit.getBudgetConsumed();
    expect(budgetConsumed).toBe(0);
  });

  test('should consume budget correctly', () => {
    const rateLimit = new LeakyBucketRateLimit(options);
    rateLimit.consumeBudget();
    expect(rateLimit.getBudgetConsumed()).toBe(1);
  });

  test('keeps growing until startRestoringBudget', () => {
    const rateLimit = new LeakyBucketRateLimit(options);
    rateLimit.consumeBudget();
    rateLimit.consumeBudget();
    expect(rateLimit.getBudgetConsumed()).toBe(2);

    // Advanding time before startRestoringBudget should be noop
    vi.advanceTimersByTime(options.budgetRestoreIntervalMs);
    expect(rateLimit.getBudgetConsumed()).toBe(2);

    rateLimit.startRestoringBudget();
    expect(rateLimit.getBudgetConsumed()).toBe(2);
    vi.advanceTimersByTime(options.budgetRestoreIntervalMs);
    expect(rateLimit.getBudgetConsumed()).toBe(1);
  });

  test('stops restoring budget when we consume budget again', () => {
    const rateLimit = new LeakyBucketRateLimit(options);
    rateLimit.consumeBudget();
    rateLimit.consumeBudget();
    expect(rateLimit.getBudgetConsumed()).toBe(2);

    rateLimit.startRestoringBudget();
    expect(rateLimit.getBudgetConsumed()).toBe(2);

    rateLimit.consumeBudget();
    expect(rateLimit.getBudgetConsumed()).toBe(3);
    vi.advanceTimersByTime(options.budgetRestoreIntervalMs);
    expect(rateLimit.getBudgetConsumed()).toBe(3);
  });

  test('respects maximum backoff time', () => {
    const maxBackoffMs = 50;
    const rateLimit = new LeakyBucketRateLimit({ ...options, maxBackoffMs });

    rateLimit.consumeBudget();

    expect(rateLimit.getBackoffMs()).toBeLessThanOrEqual(
      maxBackoffMs + options.maxJitterMs,
    );
    expect(rateLimit.getBackoffMs()).toBeGreaterThanOrEqual(maxBackoffMs);
  });

  test('backoff increases', () => {
    const rateLimit = new LeakyBucketRateLimit(options);

    rateLimit.consumeBudget();
    const backoffMs1 = rateLimit.getBackoffMs();
    rateLimit.consumeBudget();
    const backoffMs2 = rateLimit.getBackoffMs();
    expect(backoffMs2).toBeGreaterThan(backoffMs1);
    rateLimit.consumeBudget();
    const backoffMs3 = rateLimit.getBackoffMs();
    expect(backoffMs3).toBeGreaterThan(backoffMs2);
  });

  test('reports remaining budget correctly', () => {
    const maxAttempts = 3;
    const rateLimit = new LeakyBucketRateLimit({
      ...options,
      attemptBudgetCapacity: maxAttempts,
    });

    for (let i = 0; i < maxAttempts; i++) {
      expect(rateLimit.hasBudget()).toBe(true);
      rateLimit.consumeBudget();
    }

    expect(rateLimit.hasBudget()).toBe(false);
    rateLimit.consumeBudget();
  });
});
