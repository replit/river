/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { AsyncLocalStorage } from 'async_hooks';
import { isReadableDone, readNextResult } from '../testUtil';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  TestServiceSchema,
  SubscribableServiceSchema,
  UploadableServiceSchema,
} from '../testUtil/fixtures/services';
import {
  createClient,
  createServer,
  Ok,
  Procedure,
  ServiceSchema,
  Middleware,
} from '../router';
import { createMockTransportNetwork } from '../testUtil/fixtures/mockTransport';
import { Type } from '@sinclair/typebox';

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
    const middleware = vi.fn<Middleware>(({ next }) => next());
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
    const middleware = vi.fn<Middleware>(({ next }) => next());
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
    const middleware = vi.fn<Middleware>(({ next }) => next());
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
    const middleware = vi.fn<Middleware>(({ next }) => next());
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
    const middleware1 = vi.fn<Middleware>(({ next }) => {
      next();
    });
    const middleware2 = vi.fn<Middleware>(({ next }) => {
      next();
    });
    const middleware3 = vi.fn<Middleware>(({ next }) => {
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

  // The reason we have a test for AsyncLocalStorage is that it depends on the
  // details of how the server applies middlewares; they have to be called within
  // callbacks so that the context is preserved.
  // Unfortunately we put our selves in a tough situation where vitest doesn't support
  // async hooks when using fake timers, and we have fake timers in our global setup, so
  // we only rely on Promise.resolve().then(() => {}) to test context propagation.
  test('AsyncLocalStorage context is propagated via AsyncLocalStorage.run', async () => {
    const storage = new AsyncLocalStorage<{
      readByHandler: boolean;
      readByHandlerSignal: boolean;
      readByOtherMiddleware: boolean;
      readByMiddlewareSignal: boolean;
    }>();

    const AsyncStorageSchemas = ServiceSchema.define({
      gimmeStore: Procedure.rpc({
        requestInit: Type.Object({}),
        responseData: Type.Object({}),
        async handler({ ctx }) {
          ctx.signal.addEventListener('abort', () => {
            const s = storage.getStore();
            if (s) {
              s.readByHandlerSignal = true;
            }
          });

          return Promise.resolve().then(() => {
            const s = storage.getStore();
            if (s) {
              s.readByHandler = true;
            }

            return Ok({});
          });
        },
      }),
    });

    // Kind of a funky AsyncLocalStorage set up where the store is
    // actually accessible everywhere but we promise to always get it from
    // the storage instance and only use store in our tests.
    const store = {
      readByHandler: false,
      readByHandlerSignal: false,
      readByOtherMiddleware: false,
      readByMiddlewareSignal: false,
    };

    const middleware = vi.fn<Middleware>(({ ctx, next }) => {
      ctx.signal.addEventListener('abort', () => {
        const s = storage.getStore();
        if (s) {
          s.readByMiddlewareSignal = true;
        }
      });

      storage.run(store, () => {
        next();
      });
    });
    // testing that middlewares in the chain inheret context from the previous
    const middlewarThatReadsFromStorage = vi.fn<Middleware>(({ next }) => {
      const s = storage.getStore();
      if (s) {
        s.readByOtherMiddleware = true;
      }

      next();
    });
    // these extraneous looking middlewares are to make sure that different shapes of
    // middlewares running in the same context don't interfere with each other.
    const timeoutMiddleware = vi.fn<Middleware>(({ next }) => {
      Promise.resolve().then(() => {
        next();
      });
    });
    const promiseMiddleware = vi.fn<Middleware>(async ({ next }) => {
      await Promise.resolve();

      next();

      await Promise.resolve();
    });

    const services = { test: AsyncStorageSchemas };

    createServer(mockTransportNetwork.getServerTransport(), services, {
      middlewares: [
        timeoutMiddleware,
        promiseMiddleware,
        middleware,
        middlewarThatReadsFromStorage,
        timeoutMiddleware,
        promiseMiddleware,
      ],
    });
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    await client.test.gimmeStore.rpc({});

    expect(middleware).toHaveBeenCalledOnce();
    expect(store).toStrictEqual({
      readByHandler: true,
      readByHandlerSignal: true,
      readByOtherMiddleware: true,
      readByMiddlewareSignal: true,
    });
  });
});
