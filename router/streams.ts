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
 * This stream is not closable by the reader, the reader must wait for the writer to close it.
 *
 * The stream can only be consumed once. All consumers apply a permanent lock on the stream.
 *
 * To avoid memory leaks, ensure the stream is fully drained when it is no longer needed.
 */
export interface ReadStream<T> {
  /**
   * `iter` consumes/locks the stream and returns an iterable that can
   * be used to iterate over the stream.
   *
   * Consuming a locked stream will throw an error.
   */
  iter(): MinimalAsyncIterable<T>;
  /**
   * `drain` consumes/locks the stream and discards the content.
   *
   * Consuming a locked stream will throw an error.
   */
  drain(): undefined;
  /**
   * `asArray` consumes/locks the stream and returns a promise that resolves
   * with an array of the stream's content when the stream is closed.
   *
   * Consuming a locked stream will throw an error.
   */
  asArray(): Promise<Array<T>>;
  /**
   * `tee` splits the stream into two {@link ReadStream} instances that
   * can be consumed independently. The original stream will be locked forever.
   *
   * Consuming a locked stream will throw an error.
   */
  tee(): [ReadStream<T>, ReadStream<T>];
  /**
   * `waitForClose` returns a promise that resolves when the stream is closed.
   */
  waitForClose(): Promise<void>;
  /**
   * `isClosed` returns true if the stream was closed by the writer.
   */
  isClosed(): boolean;
  /**
   * `isLocked` returns true if the stream is being consumed (aka locked).
   */
  isLocked(): boolean;
  /**
   * `breakConsumer` interrupts the consumer of the stream, causing it to throw an {@link BreakConsumerError}.
   * The stream will remain locked forever and draining. If there is no consumer, this method is synonymous
   * with {@link drain}.
   */
  breakConsumer(): undefined;
  /**
   * `breakConsumerUnsafe` same as {@link breakConsumer}, but doesn't throw an error. The reason
   * it is unsafe is that the consumer will not be notified that the stream was interrupted, but
   * they can manually check by calling {@link isBroken}.
   */
  breakConsumerUnsafe(): undefined;
  /**
   * `isBroken` returns true if the consumer was interrupted using {@link breakConsumer}
   * or {@link breakConsumerUnsafe}.
   */
  isBroken(): boolean;
  /**
   * `requestClose` sends a request to the writer to close the stream, and resolves when the stream
   * is fully closed. The stream can still receive more data after the request is sent.
   */
  requestClose(): undefined;
  /**
   * `isCloseRequested` checks if the reader has requested to close the stream.
   */
  isCloseRequested(): boolean;
}

/**
 * `BreakConsumerError` is an error that is thrown when the consumer is interrupted.
 */
export class BreakConsumerError extends Error {
  constructor() {
    super('Consumer was interrupted');
    this.name = 'BreakConsumerError';

    if ('captureStackTrace' in Error) {
      Error.captureStackTrace(this, BreakConsumerError);
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
