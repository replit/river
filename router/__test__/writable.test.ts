import { describe, expect, it, vi } from 'vitest';
import { WritableImpl } from '../writable';

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
