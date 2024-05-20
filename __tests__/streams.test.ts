import { describe, it, expect, vi } from 'vitest';
import { InterruptedStreamError, ReadStreamImpl } from '../router/streams';

const noopCb = () => undefined;

describe('ReadStream unit', () => {
  it('should close the stream', async () => {
    const stream = new ReadStreamImpl<number>(noopCb);
    stream.triggerClose();
    expect(stream.isClosed()).toBe(true);

    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(true);
  });

  it('should synchronously lock the stream when Symbol.asyncIterable is called', () => {
    const stream = new ReadStreamImpl<number>(noopCb);
    stream[Symbol.asyncIterator]();
    expect(stream.isLocked()).toBe(true);
    expect(() => stream[Symbol.asyncIterator]()).toThrowError(TypeError);
    stream.triggerClose();
  });

  it('should synchronously lock the stream when asArray() is called', () => {
    const stream = new ReadStreamImpl<number>(noopCb);
    void stream.asArray();
    expect(stream.isLocked()).toBe(true);
    expect(() => stream[Symbol.asyncIterator]()).toThrowError(TypeError);
    stream.triggerClose();
  });

  it('should synchronously lock the stream when drain() is called', () => {
    const stream = new ReadStreamImpl<number>(noopCb);
    stream.drain();
    expect(stream.isLocked()).toBe(true);
    expect(() => stream[Symbol.asyncIterator]()).toThrowError(TypeError);
    stream.triggerClose();
  });

  it('should iterate over the values pushed to the stream', async () => {
    const stream = new ReadStreamImpl<number>(noopCb);
    const iterator = stream[Symbol.asyncIterator]();

    stream.pushValue(1);
    expect((await iterator.next()).value).toBe(1);
    stream.pushValue(2);
    expect((await iterator.next()).value).toBe(2);
    stream.pushValue(3);
    expect((await iterator.next()).value).toBe(3);
    stream.triggerClose();
    expect((await iterator.next()).done).toBe(true);
  });

  it('should iterate over the values push to the stream after close', async () => {
    const stream = new ReadStreamImpl<number>(noopCb);
    const iterator = stream[Symbol.asyncIterator]();

    stream.pushValue(1);
    stream.pushValue(2);
    stream.pushValue(3);
    stream.triggerClose();
    expect((await iterator.next()).value).toBe(1);
    expect((await iterator.next()).value).toBe(2);
    expect((await iterator.next()).value).toBe(3);
    expect((await iterator.next()).done).toBe(true);
  });

  it('should handle eager iterations gracefully', async () => {
    const stream = new ReadStreamImpl<number>(noopCb);
    const iterator = stream[Symbol.asyncIterator]();

    const next1 = iterator.next();
    const next2 = iterator.next();
    stream.pushValue(1);
    stream.pushValue(2);
    expect((await next1).value).toEqual(1);
    expect((await next2).value).toEqual(2);
    const next3 = iterator.next();
    const nextDone = iterator.next();
    stream.pushValue(3);
    stream.triggerClose();
    expect((await next3).value).toEqual(3);
    expect((await nextDone).done).toEqual(true);
  });

  it('should not resolve iterator until value is pushed or stream is closed', async () => {
    const stream = new ReadStreamImpl<number>(noopCb);

    const iterator = stream[Symbol.asyncIterator]();

    const nextValueP = iterator.next();
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        nextValueP,
      ]),
    ).toEqual('timeout');

    stream.pushValue(1);
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        nextValueP,
      ]),
    ).toEqual({ value: 1, done: false });

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
    const stream = new ReadStreamImpl<number>(noopCb);
    stream.pushValue(1);
    stream.pushValue(2);
    stream.pushValue(3);
    stream.triggerClose();

    const array = await stream.asArray();
    expect(array).toEqual([1, 2, 3]);
  });

  it('should not resolve asArray until the stream is closed', async () => {
    const stream = new ReadStreamImpl<number>(noopCb);
    stream.pushValue(1);

    const arrayP = stream.asArray();

    stream.pushValue(2);
    stream.pushValue(3);

    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        arrayP,
      ]),
    ).toEqual('timeout');

    stream.pushValue(4);
    stream.triggerClose();
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        arrayP,
      ]),
    ).toEqual([1, 2, 3, 4]);
  });

  it('should request to close the stream when requestClose is called', () => {
    const requestCloseCb = vi.fn();
    const stream = new ReadStreamImpl<number>(requestCloseCb);
    void stream.requestClose();
    expect(requestCloseCb).toHaveBeenCalled();
    expect(stream.isCloseRequested()).toBe(true);
    stream.triggerClose();
  });

  it('should request to close once the stream when requestClose is called', () => {
    const requestCloseCb = vi.fn();
    const stream = new ReadStreamImpl<number>(requestCloseCb);
    void stream.requestClose();
    void stream.requestClose();
    expect(requestCloseCb).toHaveBeenCalledTimes(1);
    stream.triggerClose();
  });

  it('should resolve waitForClose until after close', async () => {
    const stream = new ReadStreamImpl<number>(noopCb);

    const waitP = stream.waitForClose();

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
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        stream.waitForClose(),
      ]),
    ).toEqual(undefined);
  });

  it('should resolve waitForClose when called after closing', async () => {
    const stream = new ReadStreamImpl<number>(noopCb);
    stream.triggerClose();
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        stream.waitForClose(),
      ]),
    ).toEqual(undefined);
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        stream.waitForClose(),
      ]),
    ).toEqual(undefined);
  });

  it('should throw when pushing to a closed stream', async () => {
    const stream = new ReadStreamImpl<number>(noopCb);
    stream.triggerClose();
    expect(() => stream.pushValue(1)).toThrowError(Error);
  });

  it('shouild throw when closing multiple times', async () => {
    const stream = new ReadStreamImpl<number>(noopCb);
    stream.triggerClose();
    expect(() => stream.triggerClose()).toThrowError(Error);
  });

  it('should support for-await-of with iter', async () => {
    const stream = new ReadStreamImpl<number>(noopCb);

    stream.pushValue(1);
    let i = 0;
    const values = [];
    for await (const value of stream) {
      i++;
      values.push(value);

      if (i === 1) {
        stream.pushValue(2);
      } else if (i === 2) {
        stream.triggerClose();
      } else {
        expect.fail('expected iteration to stop');
      }
    }

    expect(values).toEqual([1, 2]);
  });

  describe('drain', () => {
    it('should reject the next stream iteration', async () => {
      const stream = new ReadStreamImpl<number>(noopCb);
      const iterator = stream[Symbol.asyncIterator]();
      stream.drain();
      await expect(async () => iterator.next()).rejects.toThrow(
        InterruptedStreamError,
      );
      stream.triggerClose();
    });

    it('should reject the pending stream iteration', async () => {
      const stream = new ReadStreamImpl<number>(noopCb);
      const iterator = stream[Symbol.asyncIterator]();
      const pending = iterator.next();
      stream.drain();
      await expect(async () => pending).rejects.toThrow(InterruptedStreamError);
      stream.triggerClose();
    });

    it('should reject the next stream iteration wtih a queued up value', async () => {
      const stream = new ReadStreamImpl<number>(noopCb);
      const iterator = stream[Symbol.asyncIterator]();
      stream.pushValue(1);
      stream.drain();
      await expect(async () => iterator.next()).rejects.toThrow(
        InterruptedStreamError,
      );
      stream.triggerClose();
    });

    it('should reject the next stream iteration with a queued up value after stream is closed', async () => {
      const stream = new ReadStreamImpl<number>(noopCb);
      const iterator = stream[Symbol.asyncIterator]();
      stream.pushValue(1);
      stream.triggerClose();
      stream.drain();
      await expect(async () => iterator.next()).rejects.toThrow(
        InterruptedStreamError,
      );
    });

    it('should not reject the next stream iteration with an empty queue after stream is closed', async () => {
      const stream = new ReadStreamImpl<number>(noopCb);
      const iterator = stream[Symbol.asyncIterator]();
      stream.triggerClose();
      stream.drain();
      expect((await iterator.next()).done).toEqual(true);
    });

    it('should reject the next stream iteration wtih a queued up value', async () => {
      const stream = new ReadStreamImpl<number>(noopCb);
      const iterator = stream[Symbol.asyncIterator]();
      stream.pushValue(1);
      stream.drain();
      await expect(async () => iterator.next()).rejects.toThrow(
        InterruptedStreamError,
      );
      stream.triggerClose();
    });
  });
});
