import { isReadableDone, readNextResult } from '../util/testHelpers';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  DIV_BY_ZERO,
  FallibleServiceSchema,
  STREAM_ERROR,
  TestServiceSchema,
  SubscribableServiceSchema,
  UploadableServiceSchema,
} from './fixtures/services';
import { createClient, createServer, UNCAUGHT_ERROR_CODE } from '../router';
import { createMockTransportNetwork } from '../util/mockTransport';

describe('server-side test', () => {
  let mockTransportNetwork: ReturnType<typeof createMockTransportNetwork>;

  beforeEach(async () => {
    mockTransportNetwork = createMockTransportNetwork();
  });

  afterEach(async () => {
    await mockTransportNetwork.cleanup();
  });

  test('rpc basic', async () => {
    const services = { test: TestServiceSchema };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const result = await client.test.add.rpc({ n: 3 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('fallible rpc', async () => {
    const services = { test: FallibleServiceSchema };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const result = await client.test.divide.rpc({ a: 10, b: 2 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 5 } });

    const result2 = await client.test.divide.rpc({ a: 10, b: 0 });
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
    const services = { test: TestServiceSchema };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { reqWritable, resReadable } = client.test.echo.stream({});

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
    const services = { test: TestServiceSchema };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { reqWritable, resReadable } = client.test.echo.stream({});
    reqWritable.close();

    expect(await isReadableDone(resReadable)).toEqual(true);
  });

  test('stream with initialization', async () => {
    const services = { test: TestServiceSchema };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { reqWritable, resReadable } = client.test.echoWithPrefix.stream({
      prefix: 'test',
    });

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
    const services = { test: FallibleServiceSchema };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { reqWritable, resReadable } = client.test.echo.stream({});
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
    const services = { test: SubscribableServiceSchema };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { resReadable } = client.test.value.subscribe({});

    const streamResult1 = await readNextResult(resReadable);
    expect(streamResult1).toStrictEqual({ ok: true, payload: { result: 0 } });

    const result = await client.test.add.rpc({ n: 3 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });

    const streamResult2 = await readNextResult(resReadable);
    expect(streamResult2).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('uploads', async () => {
    const services = { test: UploadableServiceSchema };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { reqWritable, finalize } = client.test.addMultiple.upload({});

    reqWritable.write({ n: 1 });
    reqWritable.write({ n: 2 });
    reqWritable.close();
    expect(await finalize()).toStrictEqual({
      ok: true,
      payload: { result: 3 },
    });
  });

  test('uploads empty', async () => {
    const services = { test: UploadableServiceSchema };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { reqWritable, finalize } = client.test.addMultiple.upload({});
    reqWritable.close();
    expect(await finalize()).toStrictEqual({
      ok: true,
      payload: { result: 0 },
    });
  });

  test('uploads with initialization', async () => {
    const services = { test: UploadableServiceSchema };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { reqWritable, finalize } = client.test.addMultipleWithPrefix.upload({
      prefix: 'test',
    });

    reqWritable.write({ n: 1 });
    reqWritable.write({ n: 2 });
    reqWritable.close();
    expect(await finalize()).toStrictEqual({
      ok: true,
      payload: { result: 'test 3' },
    });
  });
});
