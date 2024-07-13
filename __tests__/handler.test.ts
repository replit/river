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
    const { requestWriter, responseReader } = asClientStream(
      { count: 0 },
      service.procedures.echo,
    );

    requestWriter.write({ msg: 'abc', ignore: false });
    requestWriter.write({ msg: 'def', ignore: true });
    requestWriter.write({ msg: 'ghi', ignore: false });
    requestWriter.close();

    const outputIterator = getIteratorFromStream(responseReader);
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
    const { requestWriter, responseReader } = asClientStream(
      { count: 0 },
      service.procedures.echo,
    );
    requestWriter.close();

    const result = await getIteratorFromStream(responseReader).next();
    expect(result).toStrictEqual({ done: true, value: undefined });
  });

  test('stream with initialization', async () => {
    const { requestWriter, responseReader } = asClientStream(
      { count: 0 },
      service.procedures.echoWithPrefix,
      { prefix: 'test' },
    );

    requestWriter.write({ msg: 'abc', ignore: false });
    requestWriter.write({ msg: 'def', ignore: true });
    requestWriter.write({ msg: 'ghi', ignore: false });
    requestWriter.close();

    const outputIterator = getIteratorFromStream(responseReader);
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

    await responseReader.requestClose();
    expect(await outputIterator.next()).toEqual({
      done: true,
      value: undefined,
    });
  });

  test('fallible stream', async () => {
    const service = FallibleServiceSchema.instantiate({});
    const { requestWriter, responseReader } = asClientStream(
      {},
      service.procedures.echo,
    );

    requestWriter.write({ msg: 'abc', throwResult: false, throwError: false });
    const outputIterator = getIteratorFromStream(responseReader);
    const result1 = await iterNext(outputIterator);
    expect(result1).toStrictEqual({ ok: true, payload: { response: 'abc' } });

    requestWriter.write({ msg: 'def', throwResult: true, throwError: false });
    const result2 = await iterNext(outputIterator);
    expect(result2).toStrictEqual({
      ok: false,
      payload: {
        code: STREAM_ERROR,
        message: 'field throwResult was set to true',
      },
    });

    requestWriter.write({ msg: 'ghi', throwResult: false, throwError: true });
    const result3 = await iterNext(outputIterator);
    expect(result3).toStrictEqual({
      ok: false,
      payload: {
        code: UNCAUGHT_ERROR_CODE,
        message: 'some message',
      },
    });

    requestWriter.close();
  });

  test('subscriptions', async () => {
    const service = SubscribableServiceSchema.instantiate({});
    const state = { count: new Observable(0) };
    const add = asClientRpc(state, service.procedures.add);
    const subscribe = asClientSubscription(state, service.procedures.value);

    const { responseReader } = subscribe({});
    const outputIterator = getIteratorFromStream(responseReader);
    const streamResult1 = await iterNext(outputIterator);
    expect(streamResult1).toStrictEqual({ ok: true, payload: { result: 0 } });

    const result = await add({ n: 3 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });

    const streamResult2 = await iterNext(outputIterator);
    expect(streamResult2).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('uploads', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const [requestWriter, getAddResult] = asClientUpload(
      {},
      service.procedures.addMultiple,
    );

    requestWriter.write({ n: 1 });
    requestWriter.write({ n: 2 });
    requestWriter.close();
    expect(await getAddResult()).toStrictEqual({
      ok: true,
      payload: { result: 3 },
    });
  });

  test('uploads empty', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const [requestWriter, finalize] = asClientUpload(
      {},
      service.procedures.addMultiple,
    );
    requestWriter.close();
    expect(await finalize()).toStrictEqual({
      ok: true,
      payload: { result: 0 },
    });
  });

  test('uploads with initialization', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const [requestWriter, getAddResult] = asClientUpload(
      {},
      service.procedures.addMultipleWithPrefix,
      { prefix: 'test' },
    );

    requestWriter.write({ n: 1 });
    requestWriter.write({ n: 2 });
    requestWriter.close();
    expect(await getAddResult()).toStrictEqual({
      ok: true,
      payload: { result: 'test 3' },
    });
  });
});
