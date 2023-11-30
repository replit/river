import { asClientRpc, asClientStream } from '../testUtils';
import { assert, describe, expect, test } from 'vitest';
import {
  DIV_BY_ZERO,
  FallibleServiceConstructor,
  STREAM_ERROR,
  TestServiceConstructor,
} from './fixtures';
import { UNCAUGHT_ERROR } from '../router/result';

describe('server-side test', () => {
  const service = TestServiceConstructor();
  const initialState = { count: 0 };

  test('rpc basic', async () => {
    const add = asClientRpc(initialState, service.procedures.add);
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
    const service = FallibleServiceConstructor();
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
    const [input, output] = asClientStream(
      initialState,
      service.procedures.echo,
    );

    input.push({ msg: 'abc', ignore: false });
    input.push({ msg: 'def', ignore: true });
    input.push({ msg: 'ghi', ignore: false });
    input.end();

    const result1 = await output.next().then((res) => res.value);
    assert(result1 && result1.ok);
    expect(result1.payload).toStrictEqual({ response: 'abc' });

    const result2 = await output.next().then((res) => res.value);
    assert(result2 && result2.ok);
    expect(result2.payload).toStrictEqual({ response: 'ghi' });

    expect(output.readableLength).toBe(0);
  });

  test('fallible stream', async () => {
    const service = FallibleServiceConstructor();
    const [input, output] = asClientStream({}, service.procedures.echo);

    input.push({ msg: 'abc', throwResult: false, throwError: false });
    const result1 = await output.next().then((res) => res.value);
    assert(result1 && result1.ok);
    expect(result1.payload).toStrictEqual({ response: 'abc' });

    input.push({ msg: 'def', throwResult: true, throwError: false });
    const result2 = await output.next().then((res) => res.value);
    assert(result2 && !result2.ok);
    expect(result2.payload.code).toStrictEqual(STREAM_ERROR);

    input.push({ msg: 'ghi', throwResult: false, throwError: true });
    const result3 = await output.next().then((res) => res.value);
    assert(result3 && !result3.ok);
    expect(result3.payload).toStrictEqual({
      code: UNCAUGHT_ERROR,
      message: 'some message',
    });

    input.end();
    expect(output.readableLength).toBe(0);
  });
});