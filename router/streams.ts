interface MinimalAsyncIterator<T> {
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

interface MinimalAsyncIterable<T> {
  [Symbol.asyncIterator](): MinimalAsyncIterator<T>;
}

/**
 * A `ReadStream` represents a stream of data.
 *
 * This stream is not closable by the reader, the reader must wait for
 * the writer to close it.
 *
 * The stream can only be locked (aka consumed) once and will remain locked, trying
 * to lock the stream again will throw an TypeError.
 *
 * To avoid memory leaks, ensure the stream is drained when it is no longer needed.
 */
export interface ReadStream<T> {
  /**
   * `iter` locks the stream and returns an iterable that can
   * be used to iterate over the stream.
   *
   */
  iter(): MinimalAsyncIterable<T>;
  /**
   * `asArray` locks the stream and returns a promise that resolves
   * with an array of the stream's content when the stream is closed.
   *
   */
  asArray(): Promise<Array<T>>;
  /**
   * `drain` locks the stream and discards any existing or future data.
   *
   * If there is an existing lock (e.g. using `iter`), `drain` causes
   * it to throw an {@link InterruptedStreamError}.
   */
  drain(): undefined;
  /**
   * `isLocked` returns true if the stream is locked.
   */
  isLocked(): boolean;
  /**
   * `waitForClose` returns a promise that resolves when the stream is closed,
   * does not send a close request.
   */
  waitForClose(): Promise<undefined>;
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
 * `InterruptedStreamError` is an error that is thrown when the consumer is interrupted.
 */
export class InterruptedStreamError extends Error {
  constructor() {
    super('Consumer was interrupted');
    this.name = 'InterruptedStreamError';

    if ('captureStackTrace' in Error) {
      Error.captureStackTrace(this, InterruptedStreamError);
    }
  }
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
   * `waitForCloseRequest` returns a promise that resolves when the reader requests
   * to close the stream.
   */
  waitForCloseRequest(): Promise<void>;
  /**
   * `waitForClose` returns a promise that resolves when the stream is closed
   */
  waitForClose(): Promise<void>;
  /**
   * `isClosed` returns true if the stream was closed by the writer.
   */
  isClosed(): boolean;
}

/**
 * A `ReadWriteStream` combines a Readable and Writable stream.
 */
export interface ReadWriteStream<TRead, TWrite> {
  /**
   * The reader side of the stream.
   */
  reader: ReadStream<TRead>;
  /**
   * The writer side of the stream.
   */
  writer: WriteStream<TWrite>;
}

/**
 * Internal implementation of a `ReadStream`.
 * Has internal methods to pushed data to the stream and close it.
 */
export class ReadStreamImpl<T> implements ReadStream<T> {
  /**
   * Whether the stream is closed.
   */
  private closed = false;
  /**
   * Used to for `waitForClose` and `requestClose`.
   */
  private closePromise: Promise<undefined>;
  /**
   * Resolves closePromise
   */
  private resolveClosePromise: () => void = () => undefined;
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
   * Thsi flag helps us decide what to do in cases where
   * we called drain, and stream has already closed. It
   * helps us avoid throwing an error when we could
   * simply signal that iteration is done/stream is closed.
   */
  private didDrainDisposeValues = false;
  /**
   * A list of values that have been pushed to the stream but not yet emitted to the user.
   */
  private queue: Array<T> = [];
  /**
   * Used by methods in the class to signal to the iterator that it
   * should check for the next value.
   */
  private nextPromise: Promise<void> | null = null;
  /**
   * Resolves nextPromise
   */
  private resolveNext: null | (() => void) = null;

  constructor(closeRequestCallback: () => void) {
    this.closeRequestCallback = closeRequestCallback;
    this.closePromise = new Promise((resolve) => {
      this.resolveClosePromise = () => resolve(undefined);
    });
  }

  public iter(): MinimalAsyncIterable<T> {
    if (this.locked) {
      throw new TypeError('ReadStream is already locked');
    }

    this.locked = true;

    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          // Wait until we have something in the queue
          while (this.queue.length === 0) {
            if (this.didDrainDisposeValues) {
              throw new InterruptedStreamError();
            }

            if (this.closed) {
              return {
                done: true,
                value: undefined,
              };
            }

            if (this.drained) {
              // while we could just wait and let
              // one of the above cases handle it
              // after we know if there are more
              // incoming values or the stream will
              // simply close, let's just clean up
              // as soon as possible and end the iteration
              throw new InterruptedStreamError();
            }

            if (!this.nextPromise) {
              this.nextPromise = new Promise<void>((resolve) => {
                this.resolveNext = resolve;
              });
            }

            await this.nextPromise;
            this.nextPromise = null;
            this.resolveNext = null;
          }

          // Unfortunately we have to use non-null assertion here, because T can be undefined
          // we already check for array length above anyway
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const value = this.queue.shift()!;

          return { done: false, value };
        },
      }),
    };
  }

  public async asArray(): Promise<Array<T>> {
    const iter = this.iter();
    const array: Array<T> = [];
    for await (const value of iter) {
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

    this.resolveNext?.();
  }

  public isClosed(): boolean {
    return this.closed;
  }

  public isLocked(): boolean {
    return this.locked;
  }

  public waitForClose(): Promise<undefined> {
    return this.closePromise;
  }

  public requestClose(): Promise<undefined> {
    if (!this.closeRequested) {
      this.closeRequested = true;
      this.closeRequestCallback();
    }

    return this.closePromise;
  }

  public isCloseRequested(): boolean {
    return this.closeRequested;
  }

  /**
   * @internal
   *
   * Pushes a value to the stream.
   */
  public pushValue(value: T): undefined {
    if (this.drained) {
      this.didDrainDisposeValues = true;
      return;
    }

    if (this.closed) {
      throw new Error('Cannot push to closed stream');
    }

    this.queue.push(value);
    this.resolveNext?.();
  }

  /**
   * @internal
   *
   * Triggers the close of the stream. Make sure to push all remaining
   * values before calling this method.
   */
  public triggerClose(): undefined {
    if (this.closed) {
      throw new Error('Unexpected closing multiple times');
    }

    this.closed = true;
    this.resolveNext?.();
    this.resolveClosePromise();
  }
}
