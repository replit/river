import { Static } from '@sinclair/typebox';
import { Err, Result } from './result';
import { BaseErrorSchemaType } from './errors';

export const ReadableBrokenError = {
  code: 'READABLE_BROKEN',
  message: 'Readable was broken before it is fully consumed',
} as const satisfies Static<BaseErrorSchemaType>;

/**
 * Similar to {@link Result} but with an extra error to handle cases where {@link Readable.break} is called
 */
export type ReadableResult<T, E extends Static<BaseErrorSchemaType>> = Result<
  T,
  E | typeof ReadableBrokenError
>;

/**
 * A simple {@link AsyncIterator} used in {@link Readable}
 * that doesn't have a the extra "return" and "throw" methods, and
 * the doesn't have a "done value" (TReturn).
 */
export interface ReadableIterator<T, E extends Static<BaseErrorSchemaType>> {
  next(): Promise<
    | {
        done: false;
        value: ReadableResult<T, E>;
      }
    | {
        done: true;
        value: undefined;
      }
  >;
}

/**
 * A {@link Readable} is an abstraction from which data is consumed from {@link Writable} source.
 *
 * - On the server the argument passed the procedure handler for `upload` and `stream` implements a {@link Readable} interface
 *   so you can read client's request data.
 * - On the client the returned value of `subscription` or `stream` invocation implements a {@link Readable} interface
 *   so you can read server's response data.
 *
 * A {@link Readable} can only have one consumer (iterator or {@link collect}) for the {@link Readable}'s
 * lifetime, in essense, reading from a {@link Readable} locks it forever.
 */
export interface Readable<T, E extends Static<BaseErrorSchemaType>> {
  /**
   * {@link Readable} implements AsyncIterator API and can be consumed via
   * for-await-of loops. Iteration locks the Readable. Exiting the loop
   * will **not** release the lock and it'll be equivalent of calling
   * {@link break}.
   */
  [Symbol.asyncIterator](): ReadableIterator<T, E>;
  /**
   * {@link collect} locks the {@link Readable} and returns a promise that resolves
   * with an array of the content when the {@link Readable} is fully done. This could
   * be due to the {@link Writable} end of the pipe closing cleanly, the procedure invocation
   * is cancelled, or {@link break} is called.
   */
  collect(): Promise<Array<ReadableResult<T, E>>>;
  /**
   * {@link break} locks the {@link Readable} and discards any existing or future incoming data.
   *
   * If there is an existing reader waiting for the next value, {@link break} causes it to
   * resolve with a {@link ReadableBrokenError} error.
   */
  break(): undefined;
  /**
   * {@link isReadable} returns true if it's safe to read from the {@link Readable}, either
   * via iteration or {@link collect}. It returns false if the {@link Readable} is locked
   * by a consumer (iterator or {@link collect}) or readable was broken via {@link break}.
   */
  isReadable(): boolean;
}

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
   * on this {@link Writable} or the procedure invocation ending for any reason.
   */
  isWritable(): boolean;
}

/**
 * @internal
 *
 * @see {@link createPromiseWithResolvers}
 */
interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * @internal
 *
 * Same as https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers
 * but we support versions where it doesn't exist
 */
function createPromiseWithResolvers<T>(): PromiseWithResolvers<T> {
  let resolve: (value: T) => void;
  let reject: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    // @ts-expect-error promise callbacks are sync
    resolve,
    // @ts-expect-error promise callbacks are sync
    reject,
  };
}

/**
 * Internal implementation of a {@link Readable}.
 * This should generally not be constructed directly by consumers
 * of river, but rather through either the client or procedure handlers.
 *
 * There are rare cases where this is useful to construct in tests or
 * to 'tee' a {@link Readable} to create a copy of the stream but
 * this is not the common case.
 */
export class ReadableImpl<T, E extends Static<BaseErrorSchemaType>>
  implements Readable<T, E>
{
  /**
   * Whether the {@link Readable} is closed.
   *
   * Closed {@link Readable}s are done receiving values, but that doesn't affect
   * any other aspect of the {@link Readable} such as it's consumability.
   */
  private closed = false;
  /**
   * Whether the {@link Readable} is locked.
   *
   * @see {@link Readable}'s typedoc to understand locking
   */
  private locked = false;
  /**
   * Whether {@link break} was called.
   *
   * @see {@link break} for more information
   */
  private broken = false;
  /**
   * This flag allows us to avoid emitting a {@link ReadableBrokenError} after {@link break} was called
   * in cases where the {@link queue} is fully consumed and {@link ReadableImpl} is {@link closed}. This is just an
   * ergonomic feature to avoid emitting an error in our iteration when we don't have to.
   */
  private brokenWithValuesLeftToRead = false;
  /**
   * A list of values that have been pushed to the {@link ReadableImpl} but not yet emitted to the user.
   */
  private queue: Array<ReadableResult<T, E>> = [];
  /**
   * Used by methods in the class to signal to the iterator that it
   * should check for the next value.
   */
  private next: PromiseWithResolvers<void> | null = null;
  public [Symbol.asyncIterator]() {
    if (this.locked) {
      throw new TypeError('Readable is already locked');
    }

    this.locked = true;

    /**
     * First iteration with {@link break} signals an error, the following one signals end of iteration.
     * This variable is used to signal the end of iteration.
     */
    let didSignalBreak = false;

    return {
      next: async () => {
        if (didSignalBreak) {
          return {
            done: true,
            value: undefined,
          } as const;
        }

        /**
         * In a normal iteration case the while loop can be structured as a couple of if statements,
         * in other words the loop will run at most a couple of times:
         * - it will run 0 times if we have something in the queue to consume
         * - it will run 1 time if we have nothing in the queue and then get something in the queue
         * - it will run 2 times if we have nothing in the queue and then the readable closes or breaks
         *
         * However, in a degenerate case where something has the handle to the iterator and is calling `next`
         * eagerly multiple times this loop will come in handy by queuing them up and looping as needed.
         */
        while (this.queue.length === 0) {
          if (this.closed && !this.brokenWithValuesLeftToRead) {
            return {
              done: true,
              value: undefined,
            } as const;
          }

          if (this.broken) {
            didSignalBreak = true;

            return {
              done: false,
              value: Err(ReadableBrokenError),
            } as const;
          }

          if (!this.next) {
            this.next = createPromiseWithResolvers();
          }

          await this.next.promise;
          this.next = null;
        }

        // Unfortunately we have to use non-null assertion here, because T can be undefined
        // we already check for array length above anyway
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const value = this.queue.shift()!;

        return { done: false, value } as const;
      },
      return: () => {
        this.break();

        return { done: true, value: undefined } as const;
      },
    };
  }

  /**
   * Collects all the values from the {@link Readable} into an array.
   *
   * @see {@link Readable}'s typedoc for more information
   */
  public async collect(): Promise<Array<ReadableResult<T, E>>> {
    const array: Array<ReadableResult<T, E>> = [];
    for await (const value of this) {
      array.push(value);
    }

    return array;
  }

  /**
   * Breaks the {@link Readable} and signals an error to any iterators waiting for the next value.
   *
   * @see {@link Readable}'s typedoc for more information
   */
  public break(): undefined {
    if (this.broken) {
      return;
    }

    this.locked = true;
    this.broken = true;
    this.brokenWithValuesLeftToRead = this.queue.length > 0;
    this.queue.length = 0;

    // if we have any iterators waiting for the next value,
    this.next?.resolve();
  }

  /**
   * Whether the {@link Readable} is readable.
   *
   * @see {@link Readable}'s typedoc for more information
   */
  public isReadable(): boolean {
    return !this.locked && !this.broken;
  }

  /**
   * Pushes a value to be read.
   */
  public _pushValue(value: Result<T, E>): undefined {
    if (this.broken) {
      return;
    }

    if (this.closed) {
      throw new Error('Cannot push to closed Readable');
    }

    this.queue.push(value);
    this.next?.resolve();
  }

  /**
   * Triggers the close of the {@link Readable}. Make sure to push all remaining
   * values before calling this method.
   */
  public _triggerClose(): undefined {
    if (this.closed) {
      throw new Error('Unexpected closing multiple times');
    }

    this.closed = true;
    this.next?.resolve();
  }

  /**
   * @internal meant for use within river, not exposed as a public API
   */
  public _hasValuesInQueue(): boolean {
    return this.queue.length > 0;
  }

  /**
   * Whether the {@link Readable} is closed.
   */
  public isClosed(): boolean {
    return this.closed;
  }
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

  constructor(callbacks: { writeCb: (value: T) => void; closeCb: () => void }) {
    this.writeCb = callbacks.writeCb;
    this.closeCb = callbacks.closeCb;
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
