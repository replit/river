import {
  asClientRpc,
  asClientStream,
  asClientSubscription,
  asClientUpload,
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
import { UNCAUGHT_ERROR } from '../router/result';
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
    const [input, output] = asClientStream(
      { count: 0 },
      service.procedures.echo,
    );

    input.push({ msg: 'abc', ignore: false });
    input.push({ msg: 'def', ignore: true });
    input.push({ msg: 'ghi', ignore: false });
    input.end();

    const result1 = await iterNext(output);
    expect(result1).toStrictEqual({ ok: true, payload: { response: 'abc' } });

    const result2 = await iterNext(output);
    expect(result2).toStrictEqual({ ok: true, payload: { response: 'ghi' } });

    expect(output.readableLength).toBe(0);
  });

  test('stream empty', async () => {
    const [input, output] = asClientStream(
      { count: 0 },
      service.procedures.echo,
    );
    input.end();

    const result = await output.next();
    expect(result).toStrictEqual({ done: true, value: undefined });

    expect(output.readableLength).toBe(0);
  });

  test('stream with initialization', async () => {
    const [input, output] = asClientStream(
      { count: 0 },
      service.procedures.echoWithPrefix,
      { prefix: 'test' },
    );

    input.push({ msg: 'abc', ignore: false });
    input.push({ msg: 'def', ignore: true });
    input.push({ msg: 'ghi', ignore: false });
    input.end();

    const result1 = await iterNext(output);
    expect(result1).toStrictEqual({
      ok: true,
      payload: { response: 'test abc' },
    });

    const result2 = await iterNext(output);
    expect(result2).toStrictEqual({
      ok: true,
      payload: { response: 'test ghi' },
    });

    expect(output.readableLength).toBe(0);
  });

  test('fallible stream', async () => {
    const service = FallibleServiceSchema.instantiate({});
    const [input, output] = asClientStream({}, service.procedures.echo);

    input.push({ msg: 'abc', throwResult: false, throwError: false });
    const result1 = await iterNext(output);
    expect(result1).toStrictEqual({ ok: true, payload: { response: 'abc' } });

    input.push({ msg: 'def', throwResult: true, throwError: false });
    const result2 = await iterNext(output);
    expect(result2).toStrictEqual({
      ok: false,
      payload: {
        code: STREAM_ERROR,
        message: 'field throwResult was set to true',
      },
    });

    input.push({ msg: 'ghi', throwResult: false, throwError: true });
    const result3 = await iterNext(output);
    expect(result3).toStrictEqual({
      ok: false,
      payload: {
        code: UNCAUGHT_ERROR,
        message: 'some message',
      },
    });

    input.end();
    expect(output.readableLength).toBe(0);
  });

  test('subscriptions', async () => {
    const service = SubscribableServiceSchema.instantiate({});
    const state = { count: new Observable(0) };
    const add = asClientRpc(state, service.procedures.add);
    const subscribe = asClientSubscription(state, service.procedures.value);

    const stream = subscribe({});
    const streamResult1 = await iterNext(stream);
    expect(streamResult1).toStrictEqual({ ok: true, payload: { result: 0 } });

    const result = await add({ n: 3 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });

    const streamResult2 = await iterNext(stream);
    expect(streamResult2).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('uploads', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const [input, result] = asClientUpload({}, service.procedures.addMultiple);

    input.push({ n: 1 });
    input.push({ n: 2 });
    input.end();
    expect(await result).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('uploads empty', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const [input, result] = asClientUpload({}, service.procedures.addMultiple);
    input.end();
    expect(await result).toStrictEqual({ ok: true, payload: { result: 0 } });
  });

  test('uploads with initialization', async () => {
    const service = UploadableServiceSchema.instantiate({});
    const [input, result] = asClientUpload(
      {},
      service.procedures.addMultipleWithPrefix,
      { prefix: 'test' },
    );

    input.push({ n: 1 });
    input.push({ n: 2 });
    input.end();
    expect(await result).toStrictEqual({
      ok: true,
      payload: { result: 'test 3' },
    });
  });
});
