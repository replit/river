/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { AsyncLocalStorage } from 'async_hooks';
import { isReadableDone, readNextResult } from '../testUtil';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  TestServiceSchema,
  SubscribableServiceSchema,
  UploadableServiceSchema,
  AsyncStorageSchemas,
} from '../testUtil/fixtures/services';
import { createClient, createServer } from '../router';
import { createMockTransportNetwork } from '../testUtil/fixtures/mockTransport';
import { MiddlewareContext, MiddlewareParam } from '../router/server';

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
    const middleware = vi.fn(({ next }: MiddlewareParam) => next());
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
    const middleware = vi.fn(({ next }: MiddlewareParam) => next());
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
    const middleware = vi.fn(({ next }: MiddlewareParam) => next());
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
    const middleware = vi.fn(({ next }: MiddlewareParam) => next());
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
    const middleware1 = vi.fn(({ next }: MiddlewareParam) => {
      next();
    });
    const middleware2 = vi.fn(({ next }: MiddlewareParam) => {
      next();
    });
    const middleware3 = vi.fn(({ next }: MiddlewareParam) => {
      next();
    });
    createServer(mockTransportNetwork.getServerTransport(), services, {
      middlewares: [middleware1, middleware2, middleware3],
    });
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const result = await client.test.add.rpc({ n: 3 });

    expect(middleware1.mock.invocationCallOrder[0]).toBeLessThan(
      middleware2.mock.invocationCallOrder[0],
    );
    expect(middleware2.mock.invocationCallOrder[0]).toBeLessThan(
      middleware3.mock.invocationCallOrder[0],
    );
    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });
  });

  test('can capture uncaught promise rejection with context', async () => {
    const services = { test: AsyncStorageSchemas };
    const asyncLocalStorage = new AsyncLocalStorage<MiddlewareContext>();

    let capturedError: Error | null = null;
    let capturedErrorCtx: MiddlewareContext | null = null;

    const unhandledRejectionListener = (error: Error) => {
      capturedError = error;
      capturedErrorCtx = asyncLocalStorage.getStore() ?? null;
    };

    process.on('unhandledRejection', unhandledRejectionListener);

    const middleware = vi.fn(({ ctx, next }: MiddlewareParam) => {
      asyncLocalStorage.run(ctx, next);
    });
    createServer(mockTransportNetwork.getServerTransport(), services, {
      middlewares: [middleware],
    });
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const result = await client.test.uncaughtPromise.rpc({});
    expect(result.ok).toBe(true);

    process.off('unhandledRejection', unhandledRejectionListener);

    expect(capturedError).not.toBeNull();
    expect(capturedErrorCtx).not.toBeNull();
    expect((capturedErrorCtx as unknown as MiddlewareContext).serviceName).toBe(
      'test',
    );
    expect(
      (capturedErrorCtx as unknown as MiddlewareContext).procedureName,
    ).toBe('uncaughtPromise');
  });

  test('can capture uncaught exception in middleware with context', async () => {
    const services = { test: TestServiceSchema };
    const asyncLocalStorage = new AsyncLocalStorage<MiddlewareContext>();

    let capturedError: Error | null = null;
    let capturedErrorCtx: MiddlewareContext | null = null;

    const unhandledExceptionListener = (error: Error) => {
      capturedError = error;
      capturedErrorCtx = asyncLocalStorage.getStore() ?? null;
    };

    process.on('uncaughtException', unhandledExceptionListener);

    const asyncStorageMiddleware = vi.fn(({ ctx, next }: MiddlewareParam) => {
      asyncLocalStorage.enterWith(ctx);
      // asyncLocalStorage.run(ctx, next);
      next();
    });
    const errorMiddleware = vi.fn(() => {
      throw new Error('error from middleware');
    });
    createServer(mockTransportNetwork.getServerTransport(), services, {
      middlewares: [asyncStorageMiddleware, errorMiddleware],
    });
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    void client.test.add.rpc({
      n: 3,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(capturedError).not.toBeNull();
    expect(capturedErrorCtx).not.toBeNull();
    expect((capturedErrorCtx as unknown as MiddlewareContext).serviceName).toBe(
      'test',
    );
    expect(
      (capturedErrorCtx as unknown as MiddlewareContext).procedureName,
    ).toBe('add');
  });

  test('can capture uncaught exception in middleware with context', async () => {
    const services = { test: AsyncStorageSchemas };
    const asyncLocalStorage = new AsyncLocalStorage<MiddlewareContext>();

    let capturedError: Error | null = null;
    let capturedErrorCtx: MiddlewareContext | null = null;

    const unhandledExceptionListener = (error: Error) => {
      capturedError = error;
      capturedErrorCtx = asyncLocalStorage.getStore() ?? null;
    };

    process.on('uncaughtException', unhandledExceptionListener);

    const asyncStorageMiddleware = vi.fn(({ ctx, next }: MiddlewareParam) => {
      asyncLocalStorage.enterWith(ctx);
      // asyncLocalStorage.run(ctx, next);
      next();
    });
    const errorMiddleware = vi.fn(() => {
      throw new Error('error from middleware');
    });
    createServer(mockTransportNetwork.getServerTransport(), services, {
      middlewares: [asyncStorageMiddleware, errorMiddleware],
    });
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    void client.test.throwErrorFromTimeout.rpc({});

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(capturedError).not.toBeNull();
    expect(capturedErrorCtx).not.toBeNull();
    expect((capturedErrorCtx as unknown as MiddlewareContext).serviceName).toBe(
      'test',
    );
    expect(
      (capturedErrorCtx as unknown as MiddlewareContext).procedureName,
    ).toBe('throwErrorFromTimeout');
  });
});
