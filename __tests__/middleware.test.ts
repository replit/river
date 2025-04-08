/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { isReadableDone, readNextResult } from '../testUtil';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  TestServiceSchema,
  SubscribableServiceSchema,
  UploadableServiceSchema,
} from '../testUtil/fixtures/services';
import { createClient, createServer } from '../router';
import { createMockTransportNetwork } from '../testUtil/fixtures/mockTransport';

describe('middleware test', () => {
  let mockTransportNetwork: ReturnType<typeof createMockTransportNetwork>;

  beforeEach(async () => {
    mockTransportNetwork = createMockTransportNetwork();
  });

  afterEach(async () => {
    await mockTransportNetwork.cleanup();
  });

  test('apply read-only middleware to rpc', async () => {
    const services = { test: TestServiceSchema };
    const middleware = vi.fn();
    createServer(mockTransportNetwork.getServerTransport(), services, {
      middlewares: [middleware],
    });
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const result = await client.test.add.rpc({ n: 3 });
    expect(middleware).toHaveBeenCalledOnce();
    expect(middleware).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          serviceName: 'test',
          procedureName: 'add',
          sessionId: expect.stringContaining('session-'),
          span: expect.objectContaining({}),
          streamId: expect.stringContaining(''),
          signal: expect.objectContaining({}),
          state: expect.objectContaining({}),
        }),
        reqInit: {
          n: 3,
        },
      }),
    );

    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('apply read-only middleware to stream', async () => {
    const services = { test: TestServiceSchema };
    const middleware = vi.fn();
    createServer(mockTransportNetwork.getServerTransport(), services, {
      middlewares: [middleware],
    });
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

    expect(middleware).toHaveBeenCalledOnce();
    expect(middleware).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          serviceName: 'test',
          procedureName: 'echo',
          sessionId: expect.stringContaining('session-'),
          span: expect.objectContaining({}),
          streamId: expect.stringContaining(''),
          signal: expect.objectContaining({}),
          state: expect.objectContaining({}),
        }),
        reqInit: {},
      }),
    );
  });

  test('apply read-only middleware to subscriptions', async () => {
    const services = { test: SubscribableServiceSchema };
    const middleware = vi.fn();
    createServer(mockTransportNetwork.getServerTransport(), services, {
      middlewares: [middleware],
    });
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { resReadable } = client.test.value.subscribe({});

    const streamResult1 = await readNextResult(resReadable);
    expect(streamResult1).toStrictEqual({ ok: true, payload: { result: 0 } });

    expect(middleware).toHaveBeenCalledOnce();
    expect(middleware).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          serviceName: 'test',
          procedureName: 'value',
          sessionId: expect.stringContaining('session-'),
          span: expect.objectContaining({}),
          streamId: expect.stringContaining(''),
          signal: expect.objectContaining({}),
          state: expect.objectContaining({}),
        }),
        reqInit: {},
      }),
    );

    const result = await client.test.add.rpc({ n: 3 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });

    expect(middleware).toHaveBeenCalledTimes(2);
    expect(middleware).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          serviceName: 'test',
          procedureName: 'add',
          sessionId: expect.stringContaining('session-'),
          span: expect.objectContaining({}),
          streamId: expect.stringContaining(''),
          signal: expect.objectContaining({}),
          state: expect.objectContaining({}),
        }),
        reqInit: {
          n: 3,
        },
      }),
    );

    const streamResult2 = await readNextResult(resReadable);
    expect(streamResult2).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('apply read-only middleware to uploads', async () => {
    const services = { test: UploadableServiceSchema };
    const middleware = vi.fn();
    createServer(mockTransportNetwork.getServerTransport(), services, {
      middlewares: [middleware],
    });
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

    expect(middleware).toHaveBeenCalledOnce();
    expect(middleware).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          serviceName: 'test',
          procedureName: 'addMultiple',
          sessionId: expect.stringContaining('session-'),
          span: expect.objectContaining({}),
          streamId: expect.stringContaining(''),
          signal: expect.objectContaining({}),
          state: expect.objectContaining({}),
        }),
        reqInit: {},
      }),
    );
  });

  test('apply multiple middlewares in order', async () => {
    const services = { test: TestServiceSchema };
    // counter for checking the call order
    let callOrder = 0;
    const middleware1 = vi.fn(() => {
      callOrder++;
      expect(callOrder).toBe(1);
    });
    const middleware2 = vi.fn(() => {
      callOrder++;
      expect(callOrder).toBe(2);
    });
    const middleware3 = vi.fn(() => {
      callOrder++;
      expect(callOrder).toBe(3);
    });
    createServer(mockTransportNetwork.getServerTransport(), services, {
      middlewares: [middleware1, middleware2, middleware3],
    });
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const result = await client.test.add.rpc({ n: 3 });
    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });
  });
});
