/**
 * Represents an observable value that can be subscribed to for changes.
 * @template T - The type of the value being observed.
 */
export class Observable<T> {
  value: T;
  private listeners: Set<(val: T) => void>;

  constructor(initialValue: T) {
    this.value = initialValue;
    this.listeners = new Set();
  }

  /**
   * Gets the current value of the observable.
   */
  get() {
    return this.value;
  }

  /**
   * Sets the current value of the observable. All listeners will get an update with this value.
   * @param newValue - The new value to set.
   */
  set(tx: (preValue: T) => T) {
    const newValue = tx(this.value);
    this.value = newValue;
    this.listeners.forEach((listener) => listener(newValue));
  }

  /**
   * Subscribes to changes in the observable value.
   * @param listener - A callback function that will be called when the value changes.
   * @returns A function that can be called to unsubscribe from further notifications.
   */
  observe(listener: (val: T) => void) {
    this.listeners.add(listener);
    listener(this.get());
    return () => this.listeners.delete(listener);
  }
}
