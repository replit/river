import { Static } from '@sinclair/typebox';
import { BaseErrorSchemaType, Err, Result } from './result';

export const StreamDrainedError = {
  code: 'STREAM_DRAINED',
  message: 'Stream was drained',
} as const;

type ReadStreamResult<T, E extends Static<BaseErrorSchemaType>> = Result<
  T,
  E | typeof StreamDrainedError
>;

/**
 * Using simple iterator here to lock down the iteration and disallow
 * `return` and `throw` to be called from the outside.
 */
export interface SimpleIterator<T> {
  next(): Promise<
    | {
        done: false;
        value: T;
      }
    | {
        done: true;
        value: undefined;
      }
  >;
}

/**
 * A `ReadStream` represents a stream of data.
 *
 * This stream is not closable by the reader, the reader must wait for
 * the writer to close it.
 *
 * The stream can only be locked (aka consumed) once and will remain
 * locked, trying to lock the stream again will throw an TypeError.
 */
export interface ReadStream<T, E extends Static<BaseErrorSchemaType>> {
  /**
   * Stream implements AsyncIterator API and can be consumed via
   * for-await-of loops. Iteration locks the stream
   *
   */
  [Symbol.asyncIterator](): SimpleIterator<ReadStreamResult<T, E>>;
  /**
   * `unwrappedIter` returns an AsyncIterator that will unwrap the results coming
   * into the stream, yielding the payload if successful, otherwise throwing.
   * We generally recommend using the normal iterator instead of this method,
   * and handling errors explicitly.
   */
  unwrappedIter(): {
    [Symbol.asyncIterator](): SimpleIterator<T>;
  };
  /**
   * `asArray` locks the stream and returns a promise that resolves
   * with an array of the stream's content when the stream is closed.
   *
   */
  asArray(): Promise<Array<ReadStreamResult<T, E>>>;
  /**
   * `drain` locks the stream and discards any existing or future data.
   *
   * If there is an existing Promise waiting for the next value,
   * `drain` causes it to resolve with a {@link StreamDrainedError} error.
   */
  drain(): undefined;
  /**
   * `isLocked` returns true if the stream is locked.
   */
  isLocked(): boolean;
  /**
   * `onClose` registers a callback that will be called when the stream
   * is closed. Returns a function that can be used to unregister the
   * listener.
   */
  onClose(cb: () => void): () => void;
  /**
   * `isClosed` returns true if the stream was closed by the writer.
   *
   * Note that the stream can still have queued data and can still be
   * consumed.
   */
  isClosed(): boolean;
  /**
   * `requestClose` sends a request to the writer to close the stream,
   * and resolves the writer closes its end of the stream..
   *
   * The stream can still receive more data after the request is sent. If you
   * no longer wish to use the stream, make sure to call `drain`.
   */
  requestClose(): Promise<undefined>;
  /**
   * `isCloseRequested` checks if the reader has requested to close the stream.
   */
  isCloseRequested(): boolean;
}

/**
 * A `WriteStream` is a streams that can be written to.
 */
export interface WriteStream<T> {
  /**
   * `write` writes a value to the stream. An error is thrown if writing to a closed stream.
   */
  write(value: T): undefined;
  /**
   * `close` signals the closure of the write stream, informing the reader that the stream is complete.
   * Calling close multiple times has no effect.
   */
  close(): undefined;
  /**
   * `isCloseRequested` checks if the reader has requested to close the stream.
   */
  isCloseRequested(): boolean;
  /**
   * `onCloseRequest` registers a callback that will be called when the stream's
   * reader requests a close. Returns a function that can be used to unregister the
   * listener.
   */
  onCloseRequest(cb: () => void): () => void;
  /**
   * `isClosed` returns true if the stream was closed by the writer.
   */
  isClosed(): boolean;
  /**
   * `onClose` registers a callback that will be called when the stream
   * is closed. Returns a function that can be used to unregister the
   * listener.
   */
  onClose(cb: () => void): () => void;
}

/**
 * Internal implementation of a `ReadStream`.
 * This won't be exposed as an interface to river
 * consumers directly, it has internal river methods
 * to pushed data to the stream and close it.
 */
export class ReadStreamImpl<T, E extends Static<BaseErrorSchemaType>>
  implements ReadStream<T, E>
{
  /**
   * Whether the stream is closed.
   */
  private closed = false;
  /**
   * A list of listeners that will be called when the stream is closed.
   */
  private onCloseListeners: Set<() => void>;
  /**
   * Whether the user has requested to close the stream.
   */
  private closeRequested = false;
  /**
   * Used to signal to the outside world that the user has requested to close the stream.
   */
  private closeRequestCallback: () => void;
  /**
   * Whether the stream is locked.
   */
  private locked = false;
  /**
   * Whether drain was called.
   */
  private drained = false;
  /**
   * This flag allows us to avoid cases where drain was called,
   * but the stream is fully consumed and closed. We don't need
   * to signal that drain was called.
   */
  private didDrainDisposeValues = false;
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

  constructor(closeRequestCallback: () => void) {
    this.closeRequestCallback = closeRequestCallback;
    this.onCloseListeners = new Set();
  }

  public [Symbol.asyncIterator]() {
    if (this.isLocked()) {
      throw new TypeError('ReadStream is already locked');
    }

    // first iteration with drain signals an error, the following one signals end of iteration.
    let didSignalDrain = false;
    this.locked = true;

    return {
      next: async () => {
        if (this.drained && didSignalDrain) {
          return {
            done: true,
            value: undefined,
          } as const;
        }

        // Wait until we have something in the queue
        while (this.queue.length === 0) {
          if (this.isClosed() && !this.didDrainDisposeValues) {
            return {
              done: true,
              value: undefined,
            } as const;
          }

          if (this.drained) {
            didSignalDrain = true;

            return {
              done: false,
              value: Err(StreamDrainedError),
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
        this.drain();
        return { done: true, value: undefined } as const;
      },
    };
  }

  public unwrappedIter() {
    const iterator = this[Symbol.asyncIterator]();

    let unwrappedLock = false;
    return {
      [Symbol.asyncIterator]() {
        if (unwrappedLock) {
          throw new TypeError('ReadStream is already locked');
        }

        unwrappedLock = true;

        return {
          next: async (): ReturnType<SimpleIterator<T>['next']> => {
            const next = await iterator.next();

            if (next.done) {
              return next;
            }

            if (next.value.ok) {
              return { done: false, value: next.value.payload };
            }

            iterator.return();

            throw new Error(
              `Got err result in unwrappedIter: ${next.value.payload.code} - ${next.value.payload.message}`,
            );
          },
          return: () => iterator.return(),
        };
      },
    };
  }

  public async asArray(): Promise<Array<ReadStreamResult<T, E>>> {
    const array: Array<ReadStreamResult<T, E>> = [];
    for await (const value of this) {
      array.push(value);
    }

    return array;
  }

  public drain(): undefined {
    if (this.drained) {
      return;
    }

    this.locked = true;
    this.drained = true;
    this.didDrainDisposeValues = this.queue.length > 0;
    this.queue.length = 0;

    this.resolveNextPromise?.();
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public isLocked(): boolean {
    return this.locked;
  }

  public onClose(cb: () => void): () => void {
    if (this.isClosed()) {
      throw new Error('Stream is already closed');
    }

    this.onCloseListeners.add(cb);

    return () => {
      this.onCloseListeners.delete(cb);
    };
  }

  public requestClose(): Promise<undefined> {
    if (this.isClosed()) {
      throw new Error('Cannot request close after stream already closed');
    }

    if (!this.closeRequested) {
      this.closeRequested = true;
      this.closeRequestCallback();
    }

    return new Promise<undefined>((resolve) => {
      this.onClose(() => {
        resolve(undefined);
      });
    });
  }

  public isCloseRequested(): boolean {
    return this.closeRequested;
  }

  /**
   * @internal meant for use within river, not exposed as a public API
   *
   * Pushes a value to the stream.
   */
  public pushValue(value: Result<T, E>): undefined {
    if (this.drained) {
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
  public triggerClose(): undefined {
    if (this.isClosed()) {
      throw new Error('Unexpected closing multiple times');
    }

    this.closed = true;
    this.resolveNextPromise?.();
    this.onCloseListeners.forEach((cb) => cb());
    this.onCloseListeners.clear();

    // TODO maybe log a warn if after a certain amount of time
    // the queue was not fully consumed
  }

  /**
   * @internal meant for use within river, not exposed as a public API
   */
  public hasValuesInQueue(): boolean {
    return this.queue.length > 0;
  }
}

/**
 * Internal implementation of a `WriteStream`.
 * This won't be exposed as an interface to river
 * consumers directly, it has internal river methods
 * to trigger a close request, a way to pass on close
 * signals, and a way to push data to the stream.
 */
export class WriteStreamImpl<T> implements WriteStream<T> {
  /**
   * Passed via constructor to pass on write requests
   */
  private writeCb: (value: T) => void;
  /**
   * Whether the stream is closed.
   */
  private closed = false;
  /**
   * A list of listeners that will be called when the stream is closed.
   */
  private onCloseListeners: Set<() => void>;
  /**
   * Whether the reader has requested to close the stream.
   */
  private closeRequested = false;
  /**
   * A list of listeners that will be called when a close request is triggered.
   */
  private onCloseRequestListeners: Set<() => void>;

  constructor(writeCb: (value: T) => void) {
    this.writeCb = writeCb;
    this.onCloseListeners = new Set();
    this.onCloseRequestListeners = new Set();
  }

  public write(value: T): undefined {
    if (this.isClosed()) {
      throw new Error('Cannot write to closed stream');
    }

    this.writeCb(value);
  }

  public isClosed(): boolean {
    return this.closed;
  }

  onClose(cb: () => void): () => void {
    if (this.isClosed()) {
      cb();

      return () => undefined;
    }

    this.onCloseListeners.add(cb);

    return () => this.onCloseListeners.delete(cb);
  }

  public close(): undefined {
    if (this.isClosed()) {
      return;
    }

    this.closed = true;
    this.onCloseListeners.forEach((cb) => cb());

    // cleanup
    this.onCloseListeners.clear();
    this.onCloseRequestListeners.clear();
    this.writeCb = () => undefined;
  }

  public isCloseRequested(): boolean {
    return this.closeRequested;
  }

  public onCloseRequest(cb: () => void): () => void {
    if (this.isClosed()) {
      throw new Error('Stream is already closed');
    }

    if (this.isCloseRequested()) {
      cb();

      return () => undefined;
    }

    this.onCloseRequestListeners.add(cb);

    return () => this.onCloseRequestListeners.delete(cb);
  }

  /**
   * @internal meant for use within river, not exposed as a public API
   *
   * Triggers a close request.
   */
  public triggerCloseRequest(): undefined {
    if (this.isCloseRequested()) {
      throw new Error('Cannot trigger close request multiple times');
    }

    if (this.isClosed()) {
      throw new Error('Cannot trigger close request on closed stream');
    }

    this.closeRequested = true;
    this.onCloseRequestListeners.forEach((cb) => cb());
    this.onCloseRequestListeners.clear();
  }
}
