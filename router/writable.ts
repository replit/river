/**
 * A {@link Writeable} is a an abstraction for a {@link Readable} destination to which data is written to.
 *
 * - On the server the argument passed the procedure handler for `subscription` and `stream` implements a {@link Writeable}
 *   so you can write server's response data.
 * - On the client the returned value of `upload` or `stream` invocation implements a {@link Writeable}
 *   so you can write client's request data.
 *
 * Once closed, a {@link Writeable} can't be re-opened.`  `
 */
export interface Writable<T> {
  /**
   * {@link write} writes a value to the pipe. An error is thrown if writing to a closed {@link Writable}.
   */
  write(value: T): undefined;
  /**
   * {@link close} signals the closure of the {@link Writeable}, informing the {@link Readable} end that
   * all data has been transmitted and we've cleanly closed.
   *
   * Calling {@link close} multiple times is a no-op.
   */
  close(): undefined;
  /**
   * {@link isWritable} returns true if it's safe to call {@link write}, which
   * means that the {@link Writable} hasn't been closed due to {@link close} being called
   * on this {@link Writable} or the procedure invocation being aborted for any reason.
   */
  isWritable(): boolean;
}

/**
 * Internal implementation of a {@link Writable}.
 * This won't be exposed as an interface to river
 * consumers directly.
 */
export class WritableImpl<T> implements Writable<T> {
  /**
   * Passed via constructor to pass on calls to {@link write}
   */
  private writeCb: (value: T) => void;

  /**
   * Passed via constructor to pass on calls to {@link close}
   */
  private closeCb: () => void;
  /**
   * Whether {@link close} was called, and {@link Writable} is not writable anymore.
   */
  private closed = false;

  constructor(writeCb: (value: T) => void, closeCb: () => void) {
    this.writeCb = writeCb;
    this.closeCb = closeCb;
  }

  public write(value: T): undefined {
    if (this.closed) {
      throw new Error('Cannot write to closed Writable');
    }

    this.writeCb(value);
  }

  public isWritable(): boolean {
    return !this.closed;
  }

  public close(): undefined {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.writeCb = () => undefined;
    this.closeCb();
    this.closeCb = () => undefined;
  }

  /**
   * @internal meant for use within river, not exposed as a public API
   */
  public isClosed(): boolean {
    return this.closed;
  }
}
