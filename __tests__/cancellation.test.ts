import { TNever, TObject, Type } from '@sinclair/typebox';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  Err,
  Ok,
  Procedure,
  ValidProcType,
  createClient,
  createServiceSchema,
  createServer,
} from '../router';
import { testMatrix } from '../testUtil/fixtures/matrix';
import {
  cleanupTransports,
  createPostTestCleanups,
  testFinishesCleanly,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import { CANCEL_CODE, UNCAUGHT_ERROR_CODE } from '../router/errors';
import { TestSetupHelpers } from '../testUtil/fixtures/transports';

function makeMockHandler<T extends ValidProcType>(
  _type: T,
  impl = () => {
    return new Promise<void>(() => {
      // never resolves
    });
  },
) {
  return vi.fn<
    Procedure<
      object,
      object,
      object,
      T,
      TObject,
      TObject | null,
      TObject,
      TNever
    >['handler']
  >(impl);
}

const ServiceSchema = createServiceSchema();

describe.each(testMatrix())(
  'clean handler cancellation ($transport.name transport, $codec.name codec)',

  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };

    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    describe('e2e', () => {
      test('rpc', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();

        const signalReceiver = vi.fn<(sig: AbortSignal) => void>();
        const services = {
          service: ServiceSchema.define({
            rpc: Procedure.rpc({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              handler: async ({ ctx }) => {
                signalReceiver(ctx.signal);

                return Ok({});
              },
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        await client.service.rpc.rpc({});

        await waitFor(() => {
          expect(signalReceiver).toHaveBeenCalledTimes(1);
        });

        const [sig] = signalReceiver.mock.calls[0];
        expect(sig.aborted).toEqual(true);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('stream', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const signalReceiver = vi.fn<(sig: AbortSignal) => void>();
        const services = {
          service: ServiceSchema.define({
            stream: Procedure.stream({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              handler: async ({ ctx, resWritable }) => {
                signalReceiver(ctx.signal);

                resWritable.write(Ok({}));
                resWritable.close();

                return;
              },
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { reqWritable, resReadable } = client.service.stream.stream({});

        await waitFor(() => {
          expect(signalReceiver).toHaveBeenCalledTimes(1);
        });

        const [sig] = signalReceiver.mock.calls[0];
        expect(sig.aborted).toEqual(false);

        reqWritable.close();
        await waitFor(() => expect(sig.aborted).toEqual(true));

        // collect should resolve as the stream has been properly ended
        await expect(resReadable.collect()).resolves.toEqual([Ok({})]);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('upload', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const signalReceiver = vi.fn<(sig: AbortSignal) => void>();
        const services = {
          service: ServiceSchema.define({
            upload: Procedure.upload({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              handler: async ({ ctx }) => {
                signalReceiver(ctx.signal);

                return Ok({});
              },
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { reqWritable, finalize } = client.service.upload.upload({});

        await waitFor(() => {
          expect(signalReceiver).toHaveBeenCalledTimes(1);
        });

        const [sig] = signalReceiver.mock.calls[0];
        expect(sig.aborted).toEqual(false);

        reqWritable.close();
        await waitFor(() => expect(sig.aborted).toEqual(true));

        expect(await finalize()).toEqual(Ok({}));

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('subscribe', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const signalReceiver = vi.fn<(sig: AbortSignal) => void>();
        const services = {
          service: ServiceSchema.define({
            subscribe: Procedure.subscription({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              handler: async ({ ctx, resWritable }) => {
                resWritable.close();
                signalReceiver(ctx.signal);

                return;
              },
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { resReadable } = client.service.subscribe.subscribe({});

        await waitFor(() => {
          expect(signalReceiver).toHaveBeenCalledTimes(1);
        });

        const [sig] = signalReceiver.mock.calls[0];
        expect(sig.aborted).toEqual(true);
        await expect(resReadable.collect()).resolves.toEqual([]);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });
    });
  },
);

describe.each(testMatrix())(
  'client initiated cancellation ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };

    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    describe('e2e', () => {
      test('rpc', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const handler = makeMockHandler('rpc');
        const services = {
          service: ServiceSchema.define({
            rpc: Procedure.rpc({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const clientAbortController = new AbortController();
        const resP = client.service.rpc.rpc(
          {},
          { signal: clientAbortController.signal },
        );

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx }] = handler.mock.calls[0];
        const onRequestFinished = vi.fn();
        ctx.signal.addEventListener('abort', onRequestFinished);

        clientAbortController.abort();

        await waitFor(() => {
          expect(onRequestFinished).toHaveBeenCalled();
        });
        await expect(resP).resolves.toEqual(
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        );

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('stream', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const handler = makeMockHandler('stream');
        const services = {
          service: ServiceSchema.define({
            stream: Procedure.stream({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const clientAbortController = new AbortController();
        const { reqWritable, resReadable } = client.service.stream.stream(
          {},
          { signal: clientAbortController.signal },
        );

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx, reqReadable, resWritable }] = handler.mock.calls[0];
        const onRequestFinished = vi.fn();
        ctx.signal.addEventListener('abort', onRequestFinished);

        clientAbortController.abort();

        // this should be ignored by the client since it already cancelled
        // resWritable.write(Ok({}));

        // client should get the cancel
        expect(await resReadable.collect()).toEqual([
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        ]);
        expect(reqWritable.isWritable()).toEqual(false);

        await waitFor(() => {
          expect(onRequestFinished).toHaveBeenCalled();
        });
        // server should also get the cancel
        expect(await reqReadable.collect()).toEqual([
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        ]);
        expect(resWritable.isWritable()).toEqual(false);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('upload', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const handler = makeMockHandler('upload');
        const services = {
          service: ServiceSchema.define({
            upload: Procedure.upload({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const clientAbortController = new AbortController();
        const { reqWritable, finalize } = client.service.upload.upload(
          {},
          { signal: clientAbortController.signal },
        );

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx, reqReadable }] = handler.mock.calls[0];
        const onRequestFinished = vi.fn();
        ctx.signal.addEventListener('abort', onRequestFinished);

        clientAbortController.abort();

        // client should get the cancel
        expect(await finalize()).toEqual(
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        );
        expect(reqWritable.isWritable()).toEqual(false);

        await waitFor(() => {
          expect(onRequestFinished).toHaveBeenCalled();
        });

        // server should also get the cancel
        expect(await reqReadable.collect()).toEqual([
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        ]);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('subscribe', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const handler = makeMockHandler('subscription');
        const services = {
          service: ServiceSchema.define({
            subscribe: Procedure.subscription({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const clientAbortController = new AbortController();
        const { resReadable } = client.service.subscribe.subscribe(
          {},
          { signal: clientAbortController.signal },
        );

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx, resWritable }] = handler.mock.calls[0];
        const onRequestFinished = vi.fn();
        ctx.signal.addEventListener('abort', onRequestFinished);

        clientAbortController.abort();

        // this should be ignored by the client since it already cancelled
        resWritable.write(Ok({}));

        await waitFor(() => {
          expect(onRequestFinished).toHaveBeenCalled();
        });

        // client should get the cancel
        expect(await resReadable.collect()).toEqual([
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        ]);
        expect(resWritable.isWritable()).toEqual(false);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });
    });
  },
);

describe.each(testMatrix())(
  'server explicit cancellation ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };

    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    describe('e2e', () => {
      test('rpc', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const handler = makeMockHandler('rpc');
        const services = {
          service: ServiceSchema.define({
            rpc: Procedure.rpc({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const resP = client.service.rpc.rpc({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx }] = handler.mock.calls[0];
        const onRequestFinished = vi.fn();
        ctx.signal.addEventListener('abort', onRequestFinished);

        ctx.cancel();

        await waitFor(() => {
          expect(onRequestFinished).toHaveBeenCalled();
        });
        await expect(resP).resolves.toEqual(
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        );

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('stream', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const handler = makeMockHandler('stream');
        const services = {
          service: ServiceSchema.define({
            stream: Procedure.stream({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { reqWritable, resReadable } = client.service.stream.stream({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx, reqReadable, resWritable }] = handler.mock.calls[0];

        ctx.cancel();

        expect(await reqReadable.collect()).toEqual([
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        ]);
        expect(resWritable.isWritable()).toEqual(false);

        expect(await resReadable.collect()).toEqual([
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        ]);
        expect(reqWritable.isWritable()).toEqual(false);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('upload', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const handler = makeMockHandler('upload');
        const services = {
          service: ServiceSchema.define({
            upload: Procedure.upload({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { reqWritable, finalize } = client.service.upload.upload({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx, reqReadable }] = handler.mock.calls[0];

        ctx.cancel();

        expect(await finalize()).toEqual(
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        );
        expect(reqWritable.isWritable()).toEqual(false);

        expect(await reqReadable.collect()).toEqual([
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        ]);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('subscribe', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const handler = makeMockHandler('subscription');
        const services = {
          service: ServiceSchema.define({
            subscribe: Procedure.subscription({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { resReadable } = client.service.subscribe.subscribe({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx, resWritable }] = handler.mock.calls[0];

        ctx.cancel();

        expect(await resReadable.collect()).toEqual([
          Err({
            code: CANCEL_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          }),
        ]);
        expect(resWritable.isWritable()).toEqual(false);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });
    });
  },
);

describe.each(testMatrix())('handler explicit uncaught error cancellation ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };

    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    describe('e2e', () => {
      test('rpc', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const handler = makeMockHandler('rpc');
        const services = {
          service: ServiceSchema.define({
            rpc: Procedure.rpc({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const resP = client.service.rpc.rpc({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx }] = handler.mock.calls[0];
        const onRequestFinished = vi.fn();
        ctx.signal.addEventListener('abort', onRequestFinished);

        const err = ctx.uncaught(new Error('test'));

        expect(err).toEqual(
          Err({
            code: UNCAUGHT_ERROR_CODE,
            message: 'test',
          }),
        );

        await waitFor(() => {
          expect(onRequestFinished).toHaveBeenCalled();
        });
        await expect(resP).resolves.toEqual(err);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('stream', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const handler = makeMockHandler('stream');
        const services = {
          service: ServiceSchema.define({
            stream: Procedure.stream({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { reqWritable, resReadable } = client.service.stream.stream({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx, reqReadable, resWritable }] = handler.mock.calls[0];

        const err = ctx.uncaught(new Error('test'));

        expect(err).toEqual(
          Err({
            code: UNCAUGHT_ERROR_CODE,
            message: 'test',
          }),
        );

        expect(await reqReadable.collect()).toEqual([err]);
        expect(resWritable.isWritable()).toEqual(false);

        expect(await resReadable.collect()).toEqual([err]);
        expect(reqWritable.isWritable()).toEqual(false);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('upload', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const handler = makeMockHandler('upload');
        const services = {
          service: ServiceSchema.define({
            upload: Procedure.upload({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { reqWritable, finalize } = client.service.upload.upload({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx, reqReadable }] = handler.mock.calls[0];

        const err = ctx.uncaught(new Error('test'));

        expect(err).toEqual(
          Err({
            code: UNCAUGHT_ERROR_CODE,
            message: 'test',
          }),
        );

        expect(await finalize()).toEqual(err);
        expect(reqWritable.isWritable()).toEqual(false);
        expect(await reqReadable.collect()).toEqual([err]);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('subscribe', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const handler = makeMockHandler('subscription');
        const services = {
          service: ServiceSchema.define({
            subscribe: Procedure.subscription({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { resReadable } = client.service.subscribe.subscribe({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx, resWritable }] = handler.mock.calls[0];

        const err = ctx.uncaught(new Error('test'));

        expect(err).toEqual(
          Err({
            code: UNCAUGHT_ERROR_CODE,
            message: 'test',
          }),
        );

        expect(await resReadable.collect()).toEqual([err]);
        expect(resWritable.isWritable()).toEqual(false);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });
    });
  },
);

const createRejectable = () => {
  let reject: (reason: Error) => void;
  const promise = new Promise<void>((_res, rej) => {
    reject = rej;
  });

  // @ts-expect-error promises callback are invoked immediately
  return { promise, reject };
};

describe.each(testMatrix())(
  'handler uncaught exception error cancellation ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };

    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    describe('e2e', () => {
      test('rpc', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const rejectable = createRejectable();
        const handler = makeMockHandler('rpc', () => rejectable.promise);
        const services = {
          service: ServiceSchema.define({
            rpc: Procedure.rpc({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const resP = client.service.rpc.rpc({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx }] = handler.mock.calls[0];

        const errorMessage = Math.random().toString();
        rejectable.reject(new Error(errorMessage));

        await waitFor(() => {
          expect(ctx.signal.aborted).toEqual(true);
        });
        await expect(resP).resolves.toEqual(
          Err({
            code: UNCAUGHT_ERROR_CODE,
            message: errorMessage,
          }),
        );

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('stream', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const rejectable = createRejectable();
        const handler = makeMockHandler('stream', () => rejectable.promise);
        const services = {
          service: ServiceSchema.define({
            stream: Procedure.stream({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { reqWritable, resReadable } = client.service.stream.stream({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ reqReadable, resWritable }] = handler.mock.calls[0];

        const errorMessage = Math.random().toString();
        rejectable.reject(new Error(errorMessage));

        // this should be ignored by the server since it already cancelled
        reqWritable.write(Ok({}));

        expect(await reqReadable.collect()).toEqual([
          Err({
            code: UNCAUGHT_ERROR_CODE,
            message: errorMessage,
          }),
        ]);
        expect(resWritable.isWritable()).toEqual(false);

        expect(await resReadable.collect()).toEqual([
          Err({
            code: UNCAUGHT_ERROR_CODE,
            message: errorMessage,
          }),
        ]);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('upload', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const rejectable = createRejectable();
        const handler = makeMockHandler('upload', () => rejectable.promise);
        const services = {
          service: ServiceSchema.define({
            upload: Procedure.upload({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { reqWritable, finalize } = client.service.upload.upload({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ reqReadable }] = handler.mock.calls[0];

        const errorMessage = Math.random().toString();
        rejectable.reject(new Error(errorMessage));

        // this should be ignored by the server since it already cancelled
        reqWritable.write(Ok({}));

        expect(await finalize()).toEqual(
          Err({
            code: UNCAUGHT_ERROR_CODE,
            message: errorMessage,
          }),
        );
        expect(reqWritable.isWritable()).toEqual(false);

        expect(await reqReadable.collect()).toEqual([
          Err({
            code: UNCAUGHT_ERROR_CODE,
            message: errorMessage,
          }),
        ]);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      test('subscribe', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const rejectable = createRejectable();
        const handler = makeMockHandler(
          'subscription',
          () => rejectable.promise,
        );
        const services = {
          service: ServiceSchema.define({
            subscribe: Procedure.subscription({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              handler,
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { resReadable } = client.service.subscribe.subscribe({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ resWritable }] = handler.mock.calls[0];

        const errorMessage = Math.random().toString();
        rejectable.reject(new Error(errorMessage));

        expect(await resReadable.collect()).toEqual([
          Err({
            code: UNCAUGHT_ERROR_CODE,
            message: errorMessage,
          }),
        ]);
        expect(resWritable.isWritable()).toEqual(false);

        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });
    });
  },
);
