import {
  asClientRpc,
  asClientStream,
  asClientSubscription,
  asClientUpload,
  isReadableDone,
  readNextResult,
} from '../util/testHelpers';
import { describe, expect, test } from 'vitest';
import {
  DIV_BY_ZERO,
  FallibleServiceSchema,
  STREAM_ERROR,
  TestServiceSchema,
  SubscribableServiceSchema,
  UploadableServiceSchema,
} from './fixtures/services';
import { UNCAUGHT_ERROR_CODE } from '../router';
import { Observable } from './fixtures/observable';

describe('server-side test', () => {
  const service = TestServiceSchema.instantiate({});

  test('rpc basic', async () => {
    const add = asClientRpc({ count: 0 }, service.procedures.add);
    const result = await add({ n: 3 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('rpc initial state', async () => {
    const add = asClientRpc({ count: 5 }, service.procedures.add);
    const result = await add({ n: 6 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 11 } });
  });

  test('fallible rpc', async () => {
    const service = FallibleServiceSchema.instantiate({});
    const divide = asClientRpc({}, service.procedures.divide);
    const result = await divide({ a: 10, b: 2 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 5 } });

    const result2 = await divide({ a: 10, b: 0 });
    expect(result2).toStrictEqual({
      ok: false,
      payload: {
        code: DIV_BY_ZERO,
        message: 'Cannot divide by zero',
        extras: { test: 'abc' },
      },
    });
  });

  test('stream basic', async () => {
    const { reqWritable, resReadable } = asClientStream(
      { count: 0 },
      service.procedures.echo,
    );

    reqWritable.write({ msg: 'abc', ignore: false });
    reqWritable.write({ msg: 'def', ignore: true });
    reqWritable.write({ msg: 'ghi', ignore: false });
    reqWritable.close();

    const result1 = await readNextResult(resReadable);
    expect(result1).toStrictEqual({ ok: true, payload: { response: 'abc' } });

    const result2 = await readNextResult(resReadable);
    expect(result2).toStrictEqual({ ok: true, payload: { response: 'ghi' } });

    expect(await isReadableDone(resReadable)).toEqual(true);
  });

  test('stream empty', async () => {
    const { reqWritable, resReadable } = asClientStream(
      { count: 0 },
      service.procedures.echo,
    );
    reqWritable.close();

    expect(await isReadableDone(resReadable)).toEqual(true);
  });

  test('stream with initialization', async () => {
    const { reqWritable, resReadable } = asClientStream(
      { count: 0 },
      service.procedures.echoWithPrefix,
      { prefix: 'test' },
    );

    reqWritable.write({ msg: 'abc', ignore: false });
    reqWritable.write({ msg: 'def', ignore: true });
    reqWritable.write({ msg: 'ghi', ignore: false });
    reqWritable.close();

    const result1 = await readNextResult(resReadable);
    expect(result1).toStrictEqual({
      ok: true,
      payload: { response: 'test abc' },
    });

    const result2 = await readNextResult(resReadable);
    expect(result2).toStrictEqual({
      ok: true,
      payload: { response: 'test ghi' },
    });

    expect(await isReadableDone(resReadable)).toEqual(true);
  });

  test('fallible stream', async () => {
    const service = FallibleServiceSchema.instantiate({});
    const { reqWritable, resReadable } = asClientStream(
      {},
      service.procedures.echo,
    );

    reqWritable.write({ msg: 'abc', throwResult: false, throwError: false });

    const result1 = await readNextResult(resReadable);
    expect(result1).toStrictEqual({ ok: true, payload: { response: 'abc' } });

    reqWritable.write({ msg: 'def', throwResult: true, throwError: false });
    const result2 = await readNextResult(resReadable);
    expect(result2).toStrictEqual({
      ok: false,
      payload: {
        code: STREAM_ERROR,
        message: 'field throwResult was set to true',
      },
    });

    reqWritable.write({ msg: 'ghi', throwResult: false, throwError: true });
    const result3 = await readNextResult(resReadable);
    expect(result3).toStrictEqual({
      ok: false,
      payload: {
        code: UNCAUGHT_ERROR_CODE,
        message: 'some message',
      },
    });

    reqWritable.close();
  });

  test('subscriptions', async () => {
    const service = SubscribableServiceSchema.instantiate({});
    const state = { count: new Observable(0) };
    const add = asClientRpc(state, service.procedures.add);
    const subscribe = asClientSubscription(state, service.procedures.value);

    const { resReadable } = subscribe({});

    const streamResult1 = await readNextResult(resReadable);
    expect(streamResult1).toStrictEqual({ ok: true, payload: { result: 0 } });

    const result = await add({ n: 3 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });

    const streamResult2 = await readNextResult(resReadable);
    expect(streamResult2).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('uploads', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const { reqWritable, finalize } = asClientUpload(
      {},
      service.procedures.addMultiple,
    );

    reqWritable.write({ n: 1 });
    reqWritable.write({ n: 2 });
    reqWritable.close();
    expect(await finalize()).toStrictEqual({
      ok: true,
      payload: { result: 3 },
    });
  });

  test('uploads empty', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const { reqWritable, finalize } = asClientUpload(
      {},
      service.procedures.addMultiple,
    );
    reqWritable.close();
    expect(await finalize()).toStrictEqual({
      ok: true,
      payload: { result: 0 },
    });
  });

  test('uploads with initialization', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const { reqWritable, finalize } = asClientUpload(
      {},
      service.procedures.addMultipleWithPrefix,
      { prefix: 'test' },
    );

    reqWritable.write({ n: 1 });
    reqWritable.write({ n: 2 });
    reqWritable.close();
    expect(await finalize()).toStrictEqual({
      ok: true,
      payload: { result: 'test 3' },
    });
  });
});
