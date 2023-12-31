import { createDelimitedStream } from './delim';
import { describe, test, expect, vi } from 'vitest';

describe('DelimiterParser', () => {
  test('basic transform', () => {
    const spy = vi.fn();
    const parser = createDelimitedStream();

    parser.on('data', spy);
    parser.write(Buffer.from('content 1\ncontent'));
    parser.write(Buffer.from(' 2\n'));
    parser.write(Buffer.from('content 3\ncontent 4'));
    parser.write(Buffer.from('\n\n'));
    parser.end();

    expect(spy).toHaveBeenNthCalledWith(1, Buffer.from('content 1'));
    expect(spy).toHaveBeenNthCalledWith(2, Buffer.from('content 2'));
    expect(spy).toHaveBeenNthCalledWith(3, Buffer.from('content 3'));
    expect(spy).toHaveBeenNthCalledWith(4, Buffer.from('content 4'));
    expect(spy).toHaveBeenCalledTimes(4);
  });

  test('flushes remaining data when stream ends even with no delimiter', () => {
    const parser = createDelimitedStream({ delimiter: Buffer.from([0]) });
    const spy = vi.fn();
    parser.on('data', spy);
    parser.write(Buffer.from([1]));
    expect(spy).toHaveBeenCalledTimes(0);
    parser.end();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenNthCalledWith(1, Buffer.from([1]));
  });

  test('multibyte delimiter crosses a chunk boundary', () => {
    const parser = createDelimitedStream({ delimiter: Buffer.from([0, 1]) });
    const spy = vi.fn();
    parser.on('data', spy);
    parser.write(Buffer.from([1, 2, 3, 0]));
    parser.write(Buffer.from([1, 4, 5]));
    parser.end();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, Buffer.from([1, 2, 3]));
    expect(spy).toHaveBeenNthCalledWith(2, Buffer.from([4, 5]));
  });

  test('max buffer size', () => {
    const parser = createDelimitedStream({
      maxBufferSizeBytes: 5,
    });

    const spy = vi.fn();
    const err = vi.fn();
    parser.on('data', spy);
    parser.on('error', err);
    parser.write(Buffer.from([1, 2, 3, 4, 5]));
    expect(spy).toHaveBeenCalledTimes(0);
    expect(err).toHaveBeenCalledTimes(0);

    parser.write(Buffer.from([6]));
    expect(spy).toHaveBeenCalledTimes(0);
    expect(err).toHaveBeenCalledTimes(1);
    parser.end();
  });
});
