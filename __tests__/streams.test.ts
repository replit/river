import { describe, it, expect, vi } from 'vitest';
import {
  ReadableImpl,
  WritableImpl,
  ReadableBrokenError,
} from '../router/streams';
import { Err, Ok } from '../router';
import {
  getReadableIterator,
  isReadableDone,
  readNextResult,
} from '../util/testHelpers';

interface SomeError {
  code: 'SOME_ERROR';
  message: string;
}

describe('Readable unit', () => {
  it('should close the readable', async () => {
    const readable = new ReadableImpl<number, SomeError>();
    readable._triggerClose();

    expect(await isReadableDone(readable)).toEqual(true);
  });

  it('should synchronously lock the stream when Symbol.asyncIterable is called', () => {
    const readable = new ReadableImpl<number, SomeError>();
    readable[Symbol.asyncIterator]();
    expect(readable.isReadable()).toEqual(false);
    expect(() => readable[Symbol.asyncIterator]()).toThrowError(TypeError);
    readable._triggerClose();
  });

  it('should synchronously lock the stream when collect() is called', () => {
    const readable = new ReadableImpl<number, SomeError>();
    void readable.collect();
    expect(readable.isReadable()).toEqual(false);
    expect(() => readable[Symbol.asyncIterator]()).toThrowError(TypeError);
    readable._triggerClose();
  });

  it('should synchronously lock the stream when break() is called', () => {
    const readable = new ReadableImpl<number, SomeError>();
    readable.break();
    expect(readable.isReadable()).toEqual(false);
    expect(() => readable[Symbol.asyncIterator]()).toThrowError(TypeError);
    readable._triggerClose();
  });

  it('should iterate over the values pushed to the stream', async () => {
    const readable = new ReadableImpl<number, SomeError>();

    readable._pushValue(Ok(1));
    expect(await readNextResult(readable)).toEqual(Ok(1));
    readable._pushValue(Ok(2));
    expect(await readNextResult(readable)).toEqual(Ok(2));
    readable._pushValue(Ok(3));
    expect(await readNextResult(readable)).toEqual(Ok(3));
    readable._triggerClose();
    expect(await isReadableDone(readable)).toEqual(true);
  });

  it('should iterate over the values push to the stream after close', async () => {
    const readable = new ReadableImpl<number, SomeError>();

    readable._pushValue(Ok(1));
    readable._pushValue(Ok(2));
    readable._pushValue(Ok(3));
    readable._triggerClose();
    expect(await readNextResult(readable)).toEqual(Ok(1));
    expect(await readNextResult(readable)).toEqual(Ok(2));
    expect(await readNextResult(readable)).toEqual(Ok(3));
    expect(await isReadableDone(readable)).toEqual(true);
  });

  it('should handle eager iterations gracefully', async () => {
    const readable = new ReadableImpl<number, SomeError>();

    const next1 = readNextResult(readable);
    const next2 = readNextResult(readable);
    readable._pushValue(Ok(1));
    readable._pushValue(Ok(2));
    expect(await next1).toEqual(Ok(1));
    expect(await next2).toEqual(Ok(2));
    const next3 = readNextResult(readable);
    const nextIsDone1 = isReadableDone(readable);
    const nextIsDone2 = isReadableDone(readable);
    readable._pushValue(Ok(3));
    readable._triggerClose();
    expect(await next3).toEqual(Ok(3));
    expect(await nextIsDone1).toEqual(true);
    expect(await nextIsDone2).toEqual(true);
  });

  it('should not resolve iterator until value is pushed or stream is closed', async () => {
    const readable = new ReadableImpl<number, SomeError>();

    const nextValueP = readNextResult(readable);
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        nextValueP,
      ]),
    ).toEqual('timeout');

    readable._pushValue(Ok(1));
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        nextValueP,
      ]),
    ).toEqual(Ok(1));

    const nextIsDoneP = isReadableDone(readable);
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        nextIsDoneP,
      ]),
    ).toEqual('timeout');

    readable._triggerClose();
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        nextIsDoneP,
      ]),
    ).toEqual(true);
  });

  it('should return an array of the stream values when collect is called after close', async () => {
    const readable = new ReadableImpl<number, SomeError>();
    readable._pushValue(Ok(1));
    readable._pushValue(Ok(2));
    readable._pushValue(Ok(3));
    readable._triggerClose();

    const array = await readable.collect();
    expect(array).toEqual([1, 2, 3].map(Ok));
  });

  it('should not resolve collect until the stream is closed', async () => {
    const readable = new ReadableImpl<number, SomeError>();
    readable._pushValue(Ok(1));

    const arrayP = readable.collect();

    readable._pushValue(Ok(2));
    readable._pushValue(Ok(3));

    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        arrayP,
      ]),
    ).toEqual('timeout');

    readable._pushValue(Ok(4));
    readable._triggerClose();
    expect(
      await Promise.race([
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 10)),
        arrayP,
      ]),
    ).toEqual([1, 2, 3, 4].map(Ok));
  });

  it('should throw when pushing to a closed stream', async () => {
    const readable = new ReadableImpl<number, SomeError>();
    readable._triggerClose();
    expect(() => readable._pushValue(Ok(1))).toThrowError(Error);
  });

  it('shouild throw when closing multiple times', async () => {
    const readable = new ReadableImpl<number, SomeError>();
    readable._triggerClose();
    expect(() => readable._triggerClose()).toThrowError(Error);
  });

  it('should support for-await-of', async () => {
    const readable = new ReadableImpl<number, SomeError>();

    readable._pushValue(Ok(1));
    let i = 0;
    const values = [];
    for await (const value of readable) {
      i++;
      values.push(value);

      if (i === 1) {
        readable._pushValue(Ok(2));
      } else if (i === 2) {
        readable._triggerClose();
      } else {
        expect.fail('expected iteration to stop');
      }
    }

    expect(values).toEqual([1, 2].map(Ok));
  });

  it('should support for-await-of with break', async () => {
    const readable = new ReadableImpl<number, SomeError>();

    readable._pushValue(Ok(1));
    readable._pushValue(Ok(2));

    expect(readable._hasValuesInQueue()).toBeTruthy();

    for await (const value of readable) {
      expect(value).toEqual(Ok(1));
      expect(readable._hasValuesInQueue()).toBeTruthy();
      break;
    }

    expect(readable._hasValuesInQueue()).toBeFalsy();
  });

  it('should emit error results as part of iteration', async () => {
    const readable = new ReadableImpl<number, SomeError>();

    readable._pushValue(Ok(1));
    readable._pushValue(Ok(2));
    readable._pushValue(Err({ code: 'SOME_ERROR', message: 'some error' }));
    readable._triggerClose();

    let i = 0;
    for await (const value of readable) {
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

  describe('break', () => {
    it('should signal the next stream iteration', async () => {
      const readable = new ReadableImpl<number, SomeError>();
      getReadableIterator(readable); // Grab the iterator first since break locks.
      readable.break();
      expect(await readNextResult(readable)).toEqual(Err(ReadableBrokenError));
      readable._triggerClose();
    });

    it('should signal the pending stream iteration', async () => {
      const readable = new ReadableImpl<number, SomeError>();
      const pending = readNextResult(readable);
      readable.break();
      expect(await pending).toEqual(Err(ReadableBrokenError));
      readable._triggerClose();
    });

    it('should signal the next stream iteration wtih a queued up value', async () => {
      const readable = new ReadableImpl<number, SomeError>();
      getReadableIterator(readable); // Grab the iterator first since break locks.
      readable._pushValue(Ok(1));
      expect(readable._hasValuesInQueue()).toBeTruthy();
      readable.break();
      expect(await readNextResult(readable)).toEqual(Err(ReadableBrokenError));
      expect(readable._hasValuesInQueue()).toBeFalsy();
      readable._triggerClose();
    });

    it('should signal the next stream iteration with a queued up value after stream is closed', async () => {
      const readable = new ReadableImpl<number, SomeError>();
      getReadableIterator(readable); // Grab the iterator first since break locks.
      readable._pushValue(Ok(1));
      readable._triggerClose();
      readable.break();
      expect(await readNextResult(readable)).toEqual(Err(ReadableBrokenError));
    });

    it('should not signal the next stream iteration with an empty queue after stream is closed', async () => {
      const readable = new ReadableImpl<number, SomeError>();
      getReadableIterator(readable); // Grab the iterator first since break locks.
      readable._triggerClose();
      readable.break();
      expect(await isReadableDone(readable)).toEqual(true);
    });

    it('should end iteration if draining mid-stream', async () => {
      const readable = new ReadableImpl<number, SomeError>();
      readable._pushValue(Ok(1));
      readable._pushValue(Ok(2));
      readable._pushValue(Ok(3));

      let i = 0;
      for await (const value of readable) {
        if (i === 0) {
          expect(value).toEqual(Ok(1));
          readable.break();
        } else if (i === 1) {
          expect(value).toEqual(Err(ReadableBrokenError));
        }

        i++;
      }

      expect(i).toEqual(2);
    });
  });
});

describe('Writable unit', () => {
  it('should write', () => {
    const writeCb = vi.fn();
    const writable = new WritableImpl<number>(writeCb, () => undefined);
    writable.write(1);
    writable.write(2);

    expect(writeCb).toHaveBeenNthCalledWith(1, 1);
    expect(writeCb).toHaveBeenNthCalledWith(2, 2);
  });

  it('should close the writable', () => {
    const closeCb = vi.fn();
    const writable = new WritableImpl<number>(() => undefined, closeCb);

    expect(writable.isWritable()).toBeTruthy();

    writable.close();
    expect(writable.isWritable()).toBeFalsy();
    expect(closeCb).toHaveBeenCalledOnce();
  });

  it('should allow calling close multiple times', () => {
    const closeCb = vi.fn();
    const writable = new WritableImpl<number>(() => undefined, closeCb);

    writable.close();
    writable.close();
    writable.close();
    expect(closeCb).toHaveBeenCalledOnce();
  });

  it('should throw when writing after close', () => {
    const writable = new WritableImpl<number>(
      () => undefined,
      () => undefined,
    );
    writable.close();
    expect(() => writable.write(1)).toThrowError(Error);
  });
});
