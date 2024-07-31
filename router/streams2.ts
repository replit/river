import { Static } from '@sinclair/typebox';
import { BaseErrorSchemaType, Err, Result } from './result';

export const ReadableBrokenError = {
  code: 'READABLE_BROKEN',
  message: 'Stream was drained',
} as const;

export type ReadStreamResult<T, E extends Static<BaseErrorSchemaType>> = Result<
  T,
  E | typeof ReadableBrokenError
>;

/**
 * A {@link Readable} is an abstraction from which data is consumed.
 *
 * - On the server that takes the form of a request reader, it's available to:
 *   - `upload` procedure handler
 *   - `stream` procedure handler
 * - On the client that takes the form of a response reader, it's available to:
 *   - `subscription` invokation
 *   - `stream` invokation
 *
 * A {@link Readable} can only have one reader for the {@link Readable}'s lifetime,
 * in essense, reading from a {@link Readable} locks it forever.
 *
 */
export interface Readable<T, E extends Static<BaseErrorSchemaType>> {
  /**
   * Stream implements AsyncIterator API and can be consumed via
   * for-await-of loops. Iteration locks the Readable.
   */
  [Symbol.asyncIterator](): {
    next(): Promise<
      | {
          done: false;
          value: ReadStreamResult<T, E>;
        }
      | {
          done: true;
          value: undefined;
        }
    >;
  };

  /**
   * {@link collect} locks the stream and returns a promise that resolves
   * with an array of the stream's content when the stream is closed.
   */
  collect(): Promise<Array<ReadStreamResult<T, E>>>;
  /**
   * {@link break} locks the stream and discards any existing or future data.
   *
   * If there is an existing Promise waiting for the next value,
   * {@link break} causes it to resolve with a {@link ReadableBrokenError} error.
   */
  break(): undefined;
  /**
   * {@link isReadable} returns true if it's safe to read from the stream, either
   * via iteration or {@link collect}. It returns false if the stream is locked
   * by another reader or readable was broken via {@link break}.
   */
  isReadable(): boolean;
}

/**
 * A {@link Writeable} is a an abstraction for a destination to which data is written.
 *
 * - On the server that takes the form of a response writer, it's available to:
 *   - `subscription` procedure handler
 *   - `stream` procedure handler
 * - On the client that takes the form of a request writer
 *   - `upload` invokation
 *   - `stream` invokation
 */
export interface Writable<T> {
  /**
   * {@link write} writes a value to the stream. An error is thrown if writing to a closed stream.
   */
  write(value: T): undefined;
  /**
   * {@link close} signals the closure of the write stream, informing the reader that the stream is complete.
   * Calling {@link close} multiple times has no effect.
   */
  close(): undefined;
  /**
   * {@link isWritable} returns true if it's safe to call {@link write}, which
   * means that the stream hasn't been closed due to {@link close} being called
   * or stream cancellation.
   */
  isWritable(): boolean;
}

/**
 * Internal implementation of a {@link Readable}.
 * This won't be exposed as an interface to river
 * consumers directly.
 */
export class ReadableImpl<T, E extends Static<BaseErrorSchemaType>>
  implements Readable<T, E>
{
  /**
   * Whether the stream is closed.
   */
  private closed = false;
  /**
   * Whether the stream is locked.
   */
  private locked = false;
  /**
   * Whether break was called.
   */
  private broken = false;
  /**
   * This flag allows us to avoid cases where break was called,
   * but the stream is fully consumed and closed. We don't need
   * to signal that break was called, only that the stream is closed.
   */
  private didBreakDisposeValues = false;
  /**
   * A list of values that have been pushed to the stream but not yet emitted to the user.
   */
  private queue: Array<ReadStreamResult<T, E>> = [];
  /**
   * Used by methods in the class to signal to the iterator that it
   * should check for the next value.
   */
  private nextPromise: Promise<void> | null = null;
  /**
   * Resolves nextPromise
   */
  private resolveNextPromise: null | (() => void) = null;

  public [Symbol.asyncIterator]() {
    if (this.locked) {
      throw new TypeError('Readable is already locked');
    }

    // first iteration with break signals an error, the following one signals end of iteration.
    let didSignalDrain = false;
    this.locked = true;

    return {
      next: async () => {
        if (this.broken && didSignalDrain) {
          return {
            done: true,
            value: undefined,
          } as const;
        }

        // Wait until we have something in the queue
        while (this.queue.length === 0) {
          if (this.closed && !this.didBreakDisposeValues) {
            return {
              done: true,
              value: undefined,
            } as const;
          }

          if (this.broken) {
            didSignalDrain = true;

            return {
              done: false,
              value: Err(ReadableBrokenError),
            } as const;
          }

          if (!this.nextPromise) {
            this.nextPromise = new Promise<void>((resolve) => {
              this.resolveNextPromise = resolve;
            });
          }

          await this.nextPromise;
          this.nextPromise = null;
          this.resolveNextPromise = null;
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

  public async collect(): Promise<Array<ReadStreamResult<T, E>>> {
    const array: Array<ReadStreamResult<T, E>> = [];
    for await (const value of this) {
      array.push(value);
    }

    return array;
  }

  public break(): undefined {
    if (this.broken) {
      return;
    }

    this.locked = true;
    this.broken = true;
    this.didBreakDisposeValues = this.queue.length > 0;
    this.queue.length = 0;

    // if we have any iterators waiting for the next value,
    this.resolveNextPromise?.();
  }

  public isReadable(): boolean {
    return !this.locked && !this.broken;
  }

  /**
   * @internal meant for use within river, not exposed as a public API
   *
   * Pushes a value to be read.
   */
  public _pushValue(value: Result<T, E>): undefined {
    if (this.broken) {
      return;
    }

    if (this.closed) {
      throw new Error('Cannot push to closed stream');
    }

    this.queue.push(value);
    this.resolveNextPromise?.();
  }

  /**
   * @internal meant for use within river, not exposed as a public API
   *
   * Triggers the close of the stream. Make sure to push all remaining
   * values before calling this method.
   */
  public _triggerClose(): undefined {
    if (this.closed) {
      throw new Error('Unexpected closing multiple times');
    }

    this.closed = true;
    this.resolveNextPromise?.();
  }

  /**
   * @internal meant for use within river, not exposed as a public API
   */
  public _hasValuesInQueue(): boolean {
    return this.queue.length > 0;
  }
}

/**
 * Internal implementation of a {@link Writable}.
 * This won't be exposed as an interface to river
 * consumers directly.
 */
export class WritableImpl<T> implements Writable<T> {
  /**
   * Passed via constructor to pass on writes
   */
  private writeCb: (value: T) => void;

  /**
   * Passed via constructor to pass on close
   */
  private closeCb: () => void;
  /**
   * Whether the stream is closed.
   */
  private closed = false;

  constructor(writeCb: (value: T) => void, closeCb: () => void) {
    this.writeCb = writeCb;
    this.closeCb = closeCb;
  }

  public write(value: T): undefined {
    if (this.closed) {
      throw new Error('Cannot write to closed stream');
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
}
