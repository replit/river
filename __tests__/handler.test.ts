import {
  asClientRpc,
  asClientStream,
  asClientSubscription,
  asClientUpload,
  getIteratorFromStream,
  iterNext,
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
    const { reqWriter, resReader } = asClientStream(
      { count: 0 },
      service.procedures.echo,
    );

    reqWriter.write({ msg: 'abc', ignore: false });
    reqWriter.write({ msg: 'def', ignore: true });
    reqWriter.write({ msg: 'ghi', ignore: false });
    reqWriter.close();

    const outputIterator = getIteratorFromStream(resReader);
    const result1 = await iterNext(outputIterator);
    expect(result1).toStrictEqual({ ok: true, payload: { response: 'abc' } });

    const result2 = await iterNext(outputIterator);
    expect(result2).toStrictEqual({ ok: true, payload: { response: 'ghi' } });

    expect(await outputIterator.next()).toEqual({
      done: true,
      value: undefined,
    });
  });

  test('stream empty', async () => {
    const { reqWriter, resReader } = asClientStream(
      { count: 0 },
      service.procedures.echo,
    );
    reqWriter.close();

    const result = await getIteratorFromStream(resReader).next();
    expect(result).toStrictEqual({ done: true, value: undefined });
  });

  test('stream with initialization', async () => {
    const { reqWriter, resReader } = asClientStream(
      { count: 0 },
      service.procedures.echoWithPrefix,
      { prefix: 'test' },
    );

    reqWriter.write({ msg: 'abc', ignore: false });
    reqWriter.write({ msg: 'def', ignore: true });
    reqWriter.write({ msg: 'ghi', ignore: false });
    reqWriter.close();

    const outputIterator = getIteratorFromStream(resReader);
    const result1 = await iterNext(outputIterator);
    expect(result1).toStrictEqual({
      ok: true,
      payload: { response: 'test abc' },
    });

    const result2 = await iterNext(outputIterator);
    expect(result2).toStrictEqual({
      ok: true,
      payload: { response: 'test ghi' },
    });

    await resReader.requestClose();
    expect(await outputIterator.next()).toEqual({
      done: true,
      value: undefined,
    });
  });

  test('fallible stream', async () => {
    const service = FallibleServiceSchema.instantiate({});
    const { reqWriter, resReader } = asClientStream(
      {},
      service.procedures.echo,
    );

    reqWriter.write({ msg: 'abc', throwResult: false, throwError: false });
    const outputIterator = getIteratorFromStream(resReader);
    const result1 = await iterNext(outputIterator);
    expect(result1).toStrictEqual({ ok: true, payload: { response: 'abc' } });

    reqWriter.write({ msg: 'def', throwResult: true, throwError: false });
    const result2 = await iterNext(outputIterator);
    expect(result2).toStrictEqual({
      ok: false,
      payload: {
        code: STREAM_ERROR,
        message: 'field throwResult was set to true',
      },
    });

    reqWriter.write({ msg: 'ghi', throwResult: false, throwError: true });
    const result3 = await iterNext(outputIterator);
    expect(result3).toStrictEqual({
      ok: false,
      payload: {
        code: UNCAUGHT_ERROR_CODE,
        message: 'some message',
      },
    });

    reqWriter.close();
  });

  test('subscriptions', async () => {
    const service = SubscribableServiceSchema.instantiate({});
    const state = { count: new Observable(0) };
    const add = asClientRpc(state, service.procedures.add);
    const subscribe = asClientSubscription(state, service.procedures.value);

    const { resReader } = subscribe({});
    const outputIterator = getIteratorFromStream(resReader);
    const streamResult1 = await iterNext(outputIterator);
    expect(streamResult1).toStrictEqual({ ok: true, payload: { result: 0 } });

    const result = await add({ n: 3 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });

    const streamResult2 = await iterNext(outputIterator);
    expect(streamResult2).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('uploads', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const [reqWriter, getAddResult] = asClientUpload(
      {},
      service.procedures.addMultiple,
    );

    reqWriter.write({ n: 1 });
    reqWriter.write({ n: 2 });
    reqWriter.close();
    expect(await getAddResult()).toStrictEqual({
      ok: true,
      payload: { result: 3 },
    });
  });

  test('uploads empty', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const [reqWriter, finalize] = asClientUpload(
      {},
      service.procedures.addMultiple,
    );
    reqWriter.close();
    expect(await finalize()).toStrictEqual({
      ok: true,
      payload: { result: 0 },
    });
  });

  test('uploads with initialization', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const [reqWriter, getAddResult] = asClientUpload(
      {},
      service.procedures.addMultipleWithPrefix,
      { prefix: 'test' },
    );

    reqWriter.write({ n: 1 });
    reqWriter.write({ n: 2 });
    reqWriter.close();
    expect(await getAddResult()).toStrictEqual({
      ok: true,
      payload: { result: 'test 3' },
    });
  });
});
