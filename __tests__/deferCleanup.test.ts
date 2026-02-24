import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { Type } from '@sinclair/typebox';
import {
  createClient,
  createServer,
  Ok,
  Procedure,
  createServiceSchema,
  Middleware,
} from '../router';
import { createMockTransportNetwork } from '../testUtil';
import { waitFor } from '../testUtil/fixtures/cleanup';

describe('deferCleanup', () => {
  let mockTransportNetwork: ReturnType<typeof createMockTransportNetwork>;

  beforeEach(async () => {
    mockTransportNetwork = createMockTransportNetwork();
  });

  afterEach(async () => {
    await mockTransportNetwork.cleanup();
  });

  test('cleanups run in LIFO order', async () => {
    const order: Array<number> = [];

    const services = {
      test: createServiceSchema().define({
        myRpc: Procedure.rpc({
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          async handler({ ctx }) {
            ctx.deferCleanup(() => {
              order.push(1);
            });
            ctx.deferCleanup(() => {
              order.push(2);
            });
            ctx.deferCleanup(() => {
              order.push(3);
            });

            return Ok({});
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    await client.test.myRpc.rpc({});

    await waitFor(() => {
      expect(order).toEqual([3, 2, 1]);
    });
  });

  test('cleanups run even when handler throws', async () => {
    const cleanupRan = vi.fn();

    const services = {
      test: createServiceSchema().define({
        myRpc: Procedure.rpc({
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          async handler({ ctx }) {
            ctx.deferCleanup(cleanupRan);
            throw new Error('handler error');
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    await client.test.myRpc.rpc({});

    await waitFor(() => {
      expect(cleanupRan).toHaveBeenCalledOnce();
    });
  });

  test('cleanups run when handler is cancelled', async () => {
    const cleanupRan = vi.fn();

    const services = {
      test: createServiceSchema().define({
        myRpc: Procedure.rpc({
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          async handler({ ctx }) {
            ctx.deferCleanup(cleanupRan);
            ctx.cancel('test cancel');

            return Ok({});
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    await client.test.myRpc.rpc({});

    await waitFor(() => {
      expect(cleanupRan).toHaveBeenCalledOnce();
    });
  });

  test('one cleanup throwing does not stop remaining cleanups', async () => {
    const cleanup1 = vi.fn();
    const cleanup3 = vi.fn();

    const services = {
      test: createServiceSchema().define({
        myRpc: Procedure.rpc({
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          async handler({ ctx }) {
            ctx.deferCleanup(cleanup1);
            ctx.deferCleanup(() => {
              throw new Error('cleanup error');
            });
            ctx.deferCleanup(cleanup3);

            return Ok({});
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    await client.test.myRpc.rpc({});

    // LIFO: cleanup3 runs first, then the throwing one, then cleanup1
    await waitFor(() => {
      expect(cleanup3).toHaveBeenCalledOnce();
      expect(cleanup1).toHaveBeenCalledOnce();
    });
  });

  test('async cleanups are awaited', async () => {
    const order: Array<number> = [];

    const services = {
      test: createServiceSchema().define({
        myRpc: Procedure.rpc({
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          async handler({ ctx }) {
            ctx.deferCleanup(async () => {
              await new Promise((resolve) => setTimeout(resolve, 10));
              order.push(1);
            });
            ctx.deferCleanup(async () => {
              await new Promise((resolve) => setTimeout(resolve, 10));
              order.push(2);
            });

            return Ok({});
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    await client.test.myRpc.rpc({});

    await waitFor(() => {
      expect(order).toEqual([2, 1]);
    });
  });

  test('deferCleanup works for stream procedures', async () => {
    const order: Array<number> = [];

    const services = {
      test: createServiceSchema().define({
        myStream: Procedure.stream({
          requestInit: Type.Object({}),
          requestData: Type.Object({}),
          responseData: Type.Object({}),
          async handler({ ctx, resWritable }) {
            ctx.deferCleanup(() => {
              order.push(1);
            });
            ctx.deferCleanup(() => {
              order.push(2);
            });

            resWritable.write(Ok({}));
            resWritable.close();
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { reqWritable, resReadable } = client.test.myStream.stream({});
    reqWritable.close();

    // drain the readable
    for await (const _ of resReadable) {
      // consume
    }

    await waitFor(() => {
      expect(order).toEqual([2, 1]);
    });
  });

  test('deferCleanup works for subscription procedures', async () => {
    const cleanupRan = vi.fn();

    const services = {
      test: createServiceSchema().define({
        mySub: Procedure.subscription({
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          async handler({ ctx, resWritable }) {
            ctx.deferCleanup(cleanupRan);

            resWritable.write(Ok({}));
            resWritable.close();
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { resReadable } = client.test.mySub.subscribe({});

    // drain the readable
    for await (const _ of resReadable) {
      // consume
    }

    await waitFor(() => {
      expect(cleanupRan).toHaveBeenCalledOnce();
    });
  });

  test('deferCleanup works for upload procedures', async () => {
    const order: Array<number> = [];

    const services = {
      test: createServiceSchema().define({
        myUpload: Procedure.upload({
          requestInit: Type.Object({}),
          requestData: Type.Object({ n: Type.Number() }),
          responseData: Type.Object({ result: Type.Number() }),
          async handler({ ctx, reqReadable }) {
            ctx.deferCleanup(() => {
              order.push(1);
            });
            ctx.deferCleanup(() => {
              order.push(2);
            });

            let sum = 0;
            for await (const msg of reqReadable) {
              if (msg.ok) {
                sum += msg.payload.n;
              }
            }

            return Ok({ result: sum });
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const { reqWritable, finalize } = client.test.myUpload.upload({});
    reqWritable.write({ n: 1 });
    reqWritable.write({ n: 2 });
    reqWritable.close();

    const result = await finalize();
    expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });

    await waitFor(() => {
      expect(order).toEqual([2, 1]);
    });
  });

  test('middleware deferCleanup runs after handler', async () => {
    const order: Array<string> = [];

    const middleware: Middleware = ({ ctx, next }) => {
      ctx.deferCleanup(() => {
        order.push('middleware-cleanup');
      });
      next();
    };

    const services = {
      test: createServiceSchema().define({
        myRpc: Procedure.rpc({
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          async handler({ ctx }) {
            ctx.deferCleanup(() => {
              order.push('handler-cleanup');
            });

            return Ok({});
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services, {
      middlewares: [middleware],
    });
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    await client.test.myRpc.rpc({});

    // Both middleware and handler share the same cleanup stack.
    // Since middleware registers before the handler, handler cleanup (LIFO)
    // runs first, then middleware cleanup.
    await waitFor(() => {
      expect(order).toEqual(['handler-cleanup', 'middleware-cleanup']);
    });
  });

  test('cleanup that registers more cleanups', async () => {
    const order: Array<number> = [];

    const services = {
      test: createServiceSchema().define({
        myRpc: Procedure.rpc({
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          async handler({ ctx }) {
            ctx.deferCleanup(() => {
              order.push(1);
            });
            ctx.deferCleanup(() => {
              order.push(2);
              // Register another cleanup during execution.
              // Since cleanups haven't finished, this gets pushed
              // to the array and picked up by the pop() loop.
              ctx.deferCleanup(() => {
                order.push(3);
              });
            });

            return Ok({});
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    await client.test.myRpc.rpc({});

    // LIFO: 2 pops first (pushes 3), then 3 pops next, then 1
    await waitFor(() => {
      expect(order).toEqual([2, 3, 1]);
    });
  });

  test('stream cleanup runs when streams close, not when handler returns', async () => {
    const cleanupRan = vi.fn();
    let handlerReturned = false;

    const services = {
      test: createServiceSchema().define({
        myStream: Procedure.stream({
          requestInit: Type.Object({}),
          requestData: Type.Object({}),
          responseData: Type.Object({}),
          async handler({ ctx, resWritable }) {
            ctx.deferCleanup(cleanupRan);

            // Write a response but don't close resWritable — the handler
            // returns while the procedure is still open.
            resWritable.write(Ok({}));
            handlerReturned = true;
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const abortController = new AbortController();
    const { resReadable } = client.test.myStream.stream(
      {},
      { signal: abortController.signal },
    );

    // Read the response the handler wrote
    const iter = resReadable[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(false);

    // Handler has returned but streams are still open — cleanup should NOT have run.
    await waitFor(() => expect(handlerReturned).toBe(true));
    expect(cleanupRan).not.toHaveBeenCalled();

    // Abort closes everything, triggering cleanup.
    abortController.abort();

    await waitFor(() => {
      expect(cleanupRan).toHaveBeenCalledOnce();
    });
  });

  test('deferCleanup after handler finished calls fn immediately', async () => {
    const laterCleanup = vi.fn();
    let savedCtx: { deferCleanup: (fn: () => void) => void } | undefined;

    const services = {
      test: createServiceSchema().define({
        myRpc: Procedure.rpc({
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          async handler({ ctx }) {
            savedCtx = ctx;

            return Ok({});
          },
        }),
      }),
    };

    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    await client.test.myRpc.rpc({});

    await waitFor(() => {
      expect(savedCtx).toBeDefined();
    });

    // The handler has finished and cleanups have run.
    // Registering a new cleanup should call it immediately.
    assert(savedCtx);
    savedCtx.deferCleanup(laterCleanup);
    await waitFor(() => {
      expect(laterCleanup).toHaveBeenCalledOnce();
    });
  });
});
