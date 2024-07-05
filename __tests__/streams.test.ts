import { describe, it, expect, vi } from 'vitest';
import {
  ReadStreamImpl,
  WriteStreamImpl,
  StreamDrainedError,
} from '../router/streams';
import { Err, Ok } from '../router';

const noopCb = () => undefined;

interface SomeError {
  code: 'SOME_ERROR';
  message: string;
}

describe('ReadStream unit', () => {
  it('should close the stream', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    stream.triggerClose();
    expect(stream.isClosed()).toEqual(true);

    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toEqual(true);
  });

  it('should synchronously lock the stream when Symbol.asyncIterable is called', () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    stream[Symbol.asyncIterator]();
    expect(stream.isLocked()).toEqual(true);
    expect(() => stream[Symbol.asyncIterator]()).toThrowError(TypeError);
    stream.triggerClose();
  });

  it('should synchronously lock the stream when asArray() is called', () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    void stream.asArray();
    expect(stream.isLocked()).toEqual(true);
    expect(() => stream[Symbol.asyncIterator]()).toThrowError(TypeError);
    stream.triggerClose();
  });

  it('should synchronously lock the stream when drain() is called', () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    stream.drain();
    expect(stream.isLocked()).toEqual(true);
    expect(() => stream[Symbol.asyncIterator]()).toThrowError(TypeError);
    stream.triggerClose();
  });

  it('should iterate over the values pushed to the stream', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    const iterator = stream[Symbol.asyncIterator]();

    stream.pushValue(Ok(1));
    expect((await iterator.next()).value).toEqual(Ok(1));
    stream.pushValue(Ok(2));
    expect((await iterator.next()).value).toEqual(Ok(2));
    stream.pushValue(Ok(3));
    expect((await iterator.next()).value).toEqual(Ok(3));
    stream.triggerClose();
    expect((await iterator.next()).done).toEqual(true);
  });

  it('should iterate over the values push to the stream after close', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    const iterator = stream[Symbol.asyncIterator]();

    stream.pushValue(Ok(1));
    stream.pushValue(Ok(2));
    stream.pushValue(Ok(3));
    stream.triggerClose();
    expect((await iterator.next()).value).toEqual(Ok(1));
    expect((await iterator.next()).value).toEqual(Ok(2));
    expect((await iterator.next()).value).toEqual(Ok(3));
    expect((await iterator.next()).done).toEqual(true);
  });

  it('should handle eager iterations gracefully', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    const iterator = stream[Symbol.asyncIterator]();

    const next1 = iterator.next();
    const next2 = iterator.next();
    stream.pushValue(Ok(1));
    stream.pushValue(Ok(2));
    expect((await next1).value).toEqual(Ok(1));
    expect((await next2).value).toEqual(Ok(2));
    const next3 = iterator.next();
    const nextDone = iterator.next();
    stream.pushValue(Ok(3));
    stream.triggerClose();
    expect((await next3).value).toEqual(Ok(3));
    expect((await nextDone).done).toEqual(true);
  });

  it('should not resolve iterator until value is pushed or stream is closed', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);

    const iterator = stream[Symbol.asyncIterator]();

    const nextValueP = iterator.next();
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        nextValueP,
      ]),
    ).toEqual('timeout');

    stream.pushValue(Ok(1));
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        nextValueP,
      ]),
    ).toEqual({ value: Ok(1), done: false });

    const nextDoneP = iterator.next();
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        nextDoneP,
      ]),
    ).toEqual('timeout');

    stream.triggerClose();
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        nextDoneP,
      ]),
    ).toEqual({ value: undefined, done: true });
  });

  it('should return an array of the stream values when asArray is called after close', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    stream.pushValue(Ok(1));
    stream.pushValue(Ok(2));
    stream.pushValue(Ok(3));
    stream.triggerClose();

    const array = await stream.asArray();
    expect(array).toEqual([1, 2, 3].map(Ok));
  });

  it('should not resolve asArray until the stream is closed', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    stream.pushValue(Ok(1));

    const arrayP = stream.asArray();

    stream.pushValue(Ok(2));
    stream.pushValue(Ok(3));

    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        arrayP,
      ]),
    ).toEqual('timeout');

    stream.pushValue(Ok(4));
    stream.triggerClose();
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        arrayP,
      ]),
    ).toEqual([1, 2, 3, 4].map(Ok));
  });

  it('should request to close the stream when requestClose is called', () => {
    const requestCloseCb = vi.fn();
    const stream = new ReadStreamImpl<number, SomeError>(requestCloseCb);
    void stream.requestClose();
    expect(requestCloseCb).toHaveBeenCalled();
    expect(stream.isCloseRequested()).toEqual(true);
    stream.triggerClose();
  });

  it('should request to close once the stream when requestClose is called', () => {
    const requestCloseCb = vi.fn();
    const stream = new ReadStreamImpl<number, SomeError>(requestCloseCb);
    void stream.requestClose();
    void stream.requestClose();
    expect(requestCloseCb).toHaveBeenCalledTimes(1);
    stream.triggerClose();
  });

  it('should throw when requesting to close after closing', () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    stream.triggerClose();
    expect(() => stream.requestClose()).toThrowError(Error);
  });

  it('should call onClose callback until after close', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);

    const waitP = new Promise<void>((resolve) => stream.onClose(resolve));

    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        waitP,
      ]),
    ).toEqual('timeout');

    stream.triggerClose();
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        waitP,
      ]),
    ).toEqual(undefined);
  });

  it('should error when onClose called after closing', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    stream.triggerClose();
    expect(() => stream.onClose(noopCb)).toThrowError(Error);
  });

  it('should throw when pushing to a closed stream', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    stream.triggerClose();
    expect(() => stream.pushValue(Ok(1))).toThrowError(Error);
  });

  it('shouild throw when closing multiple times', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);
    stream.triggerClose();
    expect(() => stream.triggerClose()).toThrowError(Error);
  });

  it('should support for-await-of', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);

    stream.pushValue(Ok(1));
    let i = 0;
    const values = [];
    for await (const value of stream) {
      i++;
      values.push(value);

      if (i === 1) {
        stream.pushValue(Ok(2));
      } else if (i === 2) {
        stream.triggerClose();
      } else {
        expect.fail('expected iteration to stop');
      }
    }

    expect(values).toEqual([1, 2].map(Ok));
  });

  it('should support for-await-of with break', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);

    stream.pushValue(Ok(1));
    stream.pushValue(Ok(2));

    expect(stream.hasValuesInQueue()).toBeTruthy();

    for await (const value of stream) {
      expect(value).toEqual(Ok(1));
      expect(stream.hasValuesInQueue()).toBeTruthy();
      break;
    }

    expect(stream.hasValuesInQueue()).toBeFalsy();
  });

  it('should emit error results as part of iteration', async () => {
    const stream = new ReadStreamImpl<number, SomeError>(noopCb);

    stream.pushValue(Ok(1));
    stream.pushValue(Ok(2));
    stream.pushValue(Err({ code: 'SOME_ERROR', message: 'some error' }));
    stream.triggerClose();

    let i = 0;
    for await (const value of stream) {
      if (i === 0) {
        expect(value).toEqual(Ok(1));
      } else if (i === 1) {
        expect(value).toEqual(Ok(2));
      } else if (i === 2) {
        expect(value).toEqual(
          Err({ code: 'SOME_ERROR', message: 'some error' }),
        );
      }

      i++;
    }

    expect(i).toEqual(3);
  });

  describe('drain', () => {
    it('should signal the next stream iteration', async () => {
      const stream = new ReadStreamImpl<number, SomeError>(noopCb);
      const iterator = stream[Symbol.asyncIterator]();
      stream.drain();
      expect((await iterator.next()).value).toEqual(Err(StreamDrainedError));
      stream.triggerClose();
    });
    it('should signal the pending stream iteration', async () => {
      const stream = new ReadStreamImpl<number, SomeError>(noopCb);
      const iterator = stream[Symbol.asyncIterator]();
      const pending = iterator.next();
      stream.drain();
      expect((await pending).value).toEqual(Err(StreamDrainedError));
      stream.triggerClose();
    });
    it('should signal the next stream iteration wtih a queued up value', async () => {
      const stream = new ReadStreamImpl<number, SomeError>(noopCb);
      const iterator = stream[Symbol.asyncIterator]();
      stream.pushValue(Ok(1));
      expect(stream.hasValuesInQueue()).toBeTruthy();
      stream.drain();
      expect((await iterator.next()).value).toEqual(Err(StreamDrainedError));
      expect(stream.hasValuesInQueue()).toBeFalsy();
      stream.triggerClose();
    });
    it('should signal the next stream iteration with a queued up value after stream is closed', async () => {
      const stream = new ReadStreamImpl<number, SomeError>(noopCb);
      const iterator = stream[Symbol.asyncIterator]();
      stream.pushValue(Ok(1));
      stream.triggerClose();
      stream.drain();
      expect((await iterator.next()).value).toEqual(Err(StreamDrainedError));
    });
    it('should not signal the next stream iteration with an empty queue after stream is closed', async () => {
      const stream = new ReadStreamImpl<number, SomeError>(noopCb);
      const iterator = stream[Symbol.asyncIterator]();
      stream.triggerClose();
      stream.drain();
      expect((await iterator.next()).done).toEqual(true);
    });
    it('should end iteration if draining mid-stream', async () => {
      const stream = new ReadStreamImpl<number, SomeError>(noopCb);
      stream.pushValue(Ok(1));
      stream.pushValue(Ok(2));
      stream.pushValue(Ok(3));

      let i = 0;
      for await (const value of stream) {
        if (i === 0) {
          expect(value).toEqual(Ok(1));
          stream.drain();
        } else if (i === 1) {
          expect(value).toEqual(Err(StreamDrainedError));
        }

        i++;
      }

      expect(i).toEqual(2);
    });
  });
});

describe('WriteStream unit', () => {
  it('should write', () => {
    const writeCb = vi.fn();
    const stream = new WriteStreamImpl<number>(writeCb);
    stream.write(1);
    stream.write(2);

    expect(writeCb).toHaveBeenNthCalledWith(1, 1);
    expect(writeCb).toHaveBeenNthCalledWith(2, 2);
  });

  it('should close the stream', () => {
    const stream = new WriteStreamImpl<number>(noopCb);

    expect(stream.isClosed()).toBeFalsy();

    stream.close();
    expect(stream.isClosed()).toBeTruthy();
    expect(() => stream.close()).not.toThrow();
  });

  it('should notify listeners when closing the stream', () => {
    const stream = new WriteStreamImpl<number>(noopCb);

    const cb1 = vi.fn();
    stream.onClose(cb1);
    const cb2 = vi.fn();
    stream.onClose(cb2);

    stream.close();

    expect(cb1).toHaveBeenCalled();
    expect(cb2).toHaveBeenCalled();
    expect(cb1.mock.invocationCallOrder[0]).toBeLessThan(
      cb2.mock.invocationCallOrder[0],
    );
  });

  it('should throw when writing after close', () => {
    const stream = new WriteStreamImpl<number>(noopCb);
    stream.close();
    expect(() => stream.write(1)).toThrowError(Error);
  });

  it('triggering a close request multiple times throws', () => {
    // since triggering close is an internal API meant for requests coming from the client
    // we don't expect it to be called multiple times
    const stream = new WriteStreamImpl<number>(noopCb);

    stream.triggerCloseRequest();
    expect(() => stream.triggerCloseRequest()).toThrowError(Error);
  });

  it('should trigger a close requests', () => {
    const stream = new WriteStreamImpl<number>(noopCb);

    expect(stream.isCloseRequested()).toBeFalsy();
    stream.triggerCloseRequest();
    expect(stream.isCloseRequested()).toBeTruthy();
  });

  it('should notify listeners when triggering a close request', () => {
    const stream = new WriteStreamImpl<number>(noopCb);

    const cb1 = vi.fn();
    stream.onCloseRequest(cb1);
    const cb2 = vi.fn();
    stream.onCloseRequest(cb2);

    stream.triggerCloseRequest();

    expect(cb1).toHaveBeenCalled();
    expect(cb2).toHaveBeenCalled();
    expect(cb1.mock.invocationCallOrder[0]).toBeLessThan(
      cb2.mock.invocationCallOrder[0],
    );
  });

  it('triggering a close request multiple times throws', () => {
    // since triggering close is an internal API meant for requests coming from the client
    // we don't expect it to be called multiple times
    const stream = new WriteStreamImpl<number>(noopCb);

    stream.triggerCloseRequest();
    expect(() => stream.triggerCloseRequest()).toThrowError(Error);
  });
});
