import { Observable } from './observable';
import { describe, expect, test, vitest } from 'vitest';

describe('Observable', () => {
  test('should set initial value correctly', () => {
    const initialValue = 10;
    const observable = new Observable(initialValue);
    expect(observable.value).toBe(initialValue);
  });

  test('should update value correctly', () => {
    const observable = new Observable(10);
    const newValue = 20;
    observable.set(() => newValue);
    expect(observable.value).toBe(newValue);
  });

  test('should notify listeners when value changes', () => {
    const observable = new Observable(10);
    const listener = vitest.fn();
    observable.observe(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    const newValue = 20;
    observable.set(() => newValue);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith(newValue);
  });

  test('should unsubscribe from notifications', () => {
    const observable = new Observable(10);
    const listener = vitest.fn();
    const unsubscribe = observable.observe(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    const newValue = 20;
    observable.set(() => newValue);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith(newValue);

    unsubscribe();

    const anotherValue = 30;
    observable.set(() => anotherValue);

    expect(listener).toHaveBeenCalledTimes(2); // should not be called again after unsubscribing
  });
});
