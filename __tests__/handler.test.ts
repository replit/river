import {
  asClientRpc,
  asClientStream,
  asClientSubscription,
  asClientUpload,
  getIteratorFromStream,
  iterNext,
} from '../util/testHelpers';
import { assert, describe, expect, test } from 'vitest';
import {
  DIV_BY_ZERO,
  FallibleServiceSchema,
  STREAM_ERROR,
  TestServiceSchema,
  SubscribableServiceSchema,
  UploadableServiceSchema,
} from './fixtures/services';
import { UNCAUGHT_ERROR } from '../router/result';
import { Observable } from './fixtures/observable';

describe.skip('server-side test', () => {
  const service = TestServiceSchema.instantiate({});

  test('rpc basic', async () => {
    const add = asClientRpc({ count: 0 }, service.procedures.add);
    const result = await add({ n: 3 });
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 3 });
  });

  test('rpc initial state', async () => {
    const add = asClientRpc({ count: 5 }, service.procedures.add);
    const result = await add({ n: 6 });
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 11 });
  });

  test('fallible rpc', async () => {
    const service = FallibleServiceSchema.instantiate({});
    const divide = asClientRpc({}, service.procedures.divide);
    const result = await divide({ a: 10, b: 2 });
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 5 });

    const result2 = await divide({ a: 10, b: 0 });
    assert(!result2.ok);
    expect(result2.payload).toStrictEqual({
      code: DIV_BY_ZERO,
      message: 'Cannot divide by zero',
      extras: {
        test: 'abc',
      },
    });
  });

  test('stream basic', async () => {
    const [inputWriter, outputReader] = asClientStream(
      { count: 0 },
      service.procedures.echo,
    );

    inputWriter.write({ msg: 'abc', ignore: false });
    inputWriter.write({ msg: 'def', ignore: true });
    inputWriter.write({ msg: 'ghi', ignore: false });
    inputWriter.close();

    const outputIterator = getIteratorFromStream(outputReader);
    const result1 = await iterNext(outputIterator);
    assert(result1.ok);
    expect(result1.payload).toStrictEqual({ response: 'abc' });

    const result2 = await iterNext(outputIterator);
    assert(result2.ok);
    expect(result2.payload).toStrictEqual({ response: 'ghi' });

    expect(outputIterator.next()).toEqual({ done: true, value: undefined });
  });

  test('stream with initialization', async () => {
    const [inputWriter, outputReader] = asClientStream(
      { count: 0 },
      service.procedures.echoWithPrefix,
      { prefix: 'test' },
    );

    inputWriter.write({ msg: 'abc', ignore: false });
    inputWriter.write({ msg: 'def', ignore: true });
    inputWriter.write({ msg: 'ghi', ignore: false });
    inputWriter.close();

    const outputIterator = getIteratorFromStream(outputReader);
    const result1 = await iterNext(outputIterator);
    assert(result1.ok);
    expect(result1.payload).toStrictEqual({ response: 'test abc' });

    const result2 = await iterNext(outputIterator);
    assert(result2.ok);
    expect(result2.payload).toStrictEqual({ response: 'test ghi' });

    expect(outputIterator.next()).toEqual({ done: true, value: undefined });
  });

  test('fallible stream', async () => {
    const service = FallibleServiceSchema.instantiate({});
    const [inputWriter, outputReader] = asClientStream(
      {},
      service.procedures.echo,
    );

    inputWriter.write({ msg: 'abc', throwResult: false, throwError: false });
    const outputIterator = getIteratorFromStream(outputReader);
    const result1 = await iterNext(outputIterator);
    assert(result1.ok);
    expect(result1.payload).toStrictEqual({ response: 'abc' });

    inputWriter.write({ msg: 'def', throwResult: true, throwError: false });
    const result2 = await iterNext(outputIterator);
    assert(!result2.ok);
    expect(result2.payload.code).toStrictEqual(STREAM_ERROR);

    inputWriter.write({ msg: 'ghi', throwResult: false, throwError: true });
    const result3 = await iterNext(outputIterator);
    assert(!result3.ok);
    expect(result3.payload).toStrictEqual({
      code: UNCAUGHT_ERROR,
      message: 'some message',
    });

    inputWriter.close();
  });

  test('subscriptions', async () => {
    const service = SubscribableServiceSchema.instantiate({});
    const state = { count: new Observable(0) };
    const add = asClientRpc(state, service.procedures.add);
    const subscribe = asClientSubscription(state, service.procedures.value);

    const outputReader = subscribe({});
    const outputIterator = getIteratorFromStream(outputReader);
    const streamResult1 = await iterNext(outputIterator);
    assert(streamResult1.ok);
    expect(streamResult1.payload).toStrictEqual({ result: 0 });

    const result = await add({ n: 3 });
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 3 });

    const streamResult2 = await iterNext(outputIterator);
    assert(streamResult1.ok);
    expect(streamResult2.payload).toStrictEqual({ result: 3 });
  });

  test('uploads', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const [inputWriter, result] = asClientUpload(
      {},
      service.procedures.addMultiple,
    );

    inputWriter.write({ n: 1 });
    inputWriter.write({ n: 2 });
    inputWriter.close();
    expect(await result).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('uploads with initialization', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const [inputWriter, result] = asClientUpload(
      {},
      service.procedures.addMultipleWithPrefix,
      { prefix: 'test' },
    );

    inputWriter.write({ n: 1 });
    inputWriter.write({ n: 2 });
    inputWriter.close();
    expect(await result).toStrictEqual({
      ok: true,
      payload: { result: 'test 3' },
    });
  });
});
