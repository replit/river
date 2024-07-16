import { Type } from '@sinclair/typebox';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  Err,
  Procedure,
  ServiceSchema,
  createClient,
  createServer,
} from '../router';
import { testMatrix } from './fixtures/matrix';
import {
  cleanupTransports,
  createPostTestCleanups,
  waitFor,
} from './fixtures/cleanup';
import { EventMap } from '../transport';
import {
  ABORT_CODE,
  StreamProcedure,
  UNCAUGHT_ERROR_CODE,
} from '../router/procedures';
import { ControlFlags, abortMessage } from '../transport/message';
import { TestSetupHelpers } from './fixtures/transports';
import { nanoid } from 'nanoid';
import { ProcedureHandlerContext } from '../router/context';

const serverId = 'SERVER';

describe.each(testMatrix())(
  'client initiated abort ($transport.name transport, $codec.name codec)',
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

    describe('real client, mock server', () => {
      test('rpc', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = {
          service: ServiceSchema.define({
            rpc: Procedure.rpc({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              async handler() {
                throw new Error('unimplemented');
              },
            }),
          }),
        };
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const serverOnMessage = vi.fn<[EventMap['message']]>();
        serverTransport.addEventListener('message', serverOnMessage);

        const abortController = new AbortController();
        const signal = abortController.signal;
        const resP = client.service.rpc.rpc({}, { signal });

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(1);
        });

        abortController.abort();

        await expect(resP).resolves.toEqual({
          ok: false,
          payload: {
            code: ABORT_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          },
        });

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(2);
        });

        const initStreamId = serverOnMessage.mock.calls[0][0].streamId;
        expect(serverOnMessage).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            controlFlags: ControlFlags.StreamAbortBit,
            payload: {
              ok: false,
              payload: {
                code: ABORT_CODE,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                message: expect.any(String),
              },
            },
            streamId: initStreamId,
          }),
        );
      });

      test('upload', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = {
          service: ServiceSchema.define({
            upload: Procedure.upload({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              async handler() {
                throw new Error('unimplemented');
              },
            }),
          }),
        };
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const serverOnMessage = vi.fn<[EventMap['message']]>();
        serverTransport.addEventListener('message', serverOnMessage);

        const abortController = new AbortController();
        const signal = abortController.signal;
        const { reqWriter, finalize } = client.service.upload.upload(
          {},
          { signal },
        );

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(1);
        });

        abortController.abort();

        expect(reqWriter.isClosed());
        await expect(finalize()).resolves.toEqual({
          ok: false,
          payload: {
            code: ABORT_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          },
        });

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(2);
        });

        const initStreamId = serverOnMessage.mock.calls[0][0].streamId;
        expect(serverOnMessage).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            controlFlags: ControlFlags.StreamAbortBit,
            payload: {
              ok: false,
              payload: {
                code: ABORT_CODE,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                message: expect.any(String),
              },
            },
            streamId: initStreamId,
          }),
        );
      });

      test('subscribe', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = {
          service: ServiceSchema.define({
            subscribe: Procedure.subscription({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              async handler() {
                throw new Error('unimplemented');
              },
            }),
          }),
        };
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const serverOnMessage = vi.fn<[EventMap['message']]>();
        serverTransport.addEventListener('message', serverOnMessage);

        const abortController = new AbortController();
        const signal = abortController.signal;
        const { resReader } = client.service.subscribe.subscribe(
          {},
          { signal },
        );

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(1);
        });

        abortController.abort();

        expect(resReader.isClosed());
        await expect(resReader.asArray()).resolves.toEqual([
          {
            ok: false,
            payload: {
              code: ABORT_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.any(String),
            },
          },
        ]);

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(2);
        });

        const initStreamId = serverOnMessage.mock.calls[0][0].streamId;
        expect(serverOnMessage).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            controlFlags: ControlFlags.StreamAbortBit,
            payload: {
              ok: false,
              payload: {
                code: ABORT_CODE,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                message: expect.any(String),
              },
            },
            streamId: initStreamId,
          }),
        );
      });

      test('stream', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = {
          service: ServiceSchema.define({
            stream: Procedure.stream({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              async handler() {
                throw new Error('unimplemented');
              },
            }),
          }),
        };
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const serverOnMessage = vi.fn<[EventMap['message']]>();
        serverTransport.addEventListener('message', serverOnMessage);

        const abortController = new AbortController();
        const signal = abortController.signal;
        const { reqWriter, resReader } = client.service.stream.stream(
          {},
          { signal },
        );

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(1);
        });

        abortController.abort();

        expect(resReader.isClosed());
        expect(reqWriter.isClosed());
        await expect(resReader.asArray()).resolves.toEqual([
          {
            ok: false,
            payload: {
              code: ABORT_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.any(String),
            },
          },
        ]);

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(2);
        });

        const initStreamId = serverOnMessage.mock.calls[0][0].streamId;
        expect(serverOnMessage).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            controlFlags: ControlFlags.StreamAbortBit,
            payload: {
              ok: false,
              payload: {
                code: ABORT_CODE,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                message: expect.any(String),
              },
            },
            streamId: initStreamId,
          }),
        );
      });
    });

    describe('real server, mock client', () => {
      test.each([
        { procedureType: 'rpc' },
        { procedureType: 'subscription' },
        { procedureType: 'stream' },
        { procedureType: 'upload' },
      ] as const)(
        '$procedureType: mock client, real server',
        async ({ procedureType }) => {
          const clientTransport = getClientTransport('client');
          const serverTransport = getServerTransport();
          const serviceName = 'service';
          const procedureName = procedureType;
          const handler = vi.fn().mockImplementation(
            () =>
              new Promise(() => {
                // never resolves
              }),
          );

          const services = {
            [serviceName]: ServiceSchema.define({
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
              [procedureType]: (Procedure[procedureType] as any)({
                requestInit: Type.Object({}),
                ...(procedureType === 'stream' || procedureType === 'upload'
                  ? {
                      requestData: Type.Object({}),
                    }
                  : {}),
                responseData: Type.Object({}),
                handler,
              }),
            }),
          };

          const server = createServer(serverTransport, services);

          addPostTestCleanup(async () => {
            await cleanupTransports([clientTransport, serverTransport]);
          });

          clientTransport.connect(serverId);

          const streamId = nanoid();
          clientTransport.send(serverId, {
            streamId,
            serviceName,
            procedureName,
            payload: {},
            controlFlags:
              ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
          });

          const serverOnMessage = vi.fn<[EventMap['message']]>();
          serverTransport.addEventListener('message', serverOnMessage);

          await waitFor(() => {
            expect(serverOnMessage).toHaveBeenCalledTimes(1);
          });

          expect(server.openStreams.size).toEqual(1);
          expect(handler).toHaveBeenCalledTimes(1);
          const { ctx } =
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            handler.mock.calls[0][0] as {
              ctx: ProcedureHandlerContext<object>;
            };
          const onClientAbort = vi.fn();
          ctx.clientAbortSignal.onabort = onClientAbort;

          clientTransport.send(
            serverId,
            abortMessage(
              streamId,
              Err({
                code: ABORT_CODE,
                message: '',
              }),
            ),
          );

          await waitFor(() => {
            expect(serverOnMessage).toHaveBeenCalledTimes(2);
          });

          expect(onClientAbort).toHaveBeenCalled();
          expect(server.openStreams.size).toEqual(0);
        },
      );
    });

    describe('e2e', () => {
      // testing stream only e2e as it's the most general case
      test('stream', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const handler = vi
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .fn<Parameters<StreamProcedure<any, any, any, any, any>['handler']>>()
          .mockImplementation(
            () =>
              new Promise(() => {
                // never resolves
              }),
          );
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
        createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const clientAbortController = new AbortController();

        const { reqWriter, resReader } = client.service.stream.stream(
          {},
          { signal: clientAbortController.signal },
        );

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx, reqReader, resWriter }] = handler.mock.calls[0];
        const onClientAbort = vi.fn();
        ctx.clientAbortSignal.onabort = onClientAbort;

        clientAbortController.abort();
        // this should be ignored by the client since it already aborted
        resWriter.write({ ok: true, payload: {} });
        expect(await resReader.asArray()).toEqual([
          {
            ok: false,
            payload: {
              code: ABORT_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.any(String),
            },
          },
        ]);
        expect(resReader.isClosed());
        expect(reqWriter.isClosed());

        await waitFor(() => {
          expect(onClientAbort).toHaveBeenCalled();
        });
        expect(await reqReader.asArray()).toEqual([
          {
            ok: false,
            payload: {
              code: ABORT_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.any(String),
            },
          },
        ]);
        expect(reqReader.isClosed());
        expect(resWriter.isClosed());
      });
    });
  },
);

describe.each(testMatrix())(
  'server explicit abort ($transport.name transport, $codec.name codec)',
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

    describe('real client, mock server', () => {
      test('rpc', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = {
          service: ServiceSchema.define({
            rpc: Procedure.rpc({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              async handler() {
                throw new Error('unimplemented');
              },
            }),
          }),
        };
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const serverOnMessage = vi.fn<[EventMap['message']]>();
        serverTransport.addEventListener('message', serverOnMessage);

        const resP = client.service.rpc.rpc({});

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(1);
        });

        const initStreamId = serverOnMessage.mock.calls[0][0].streamId;

        serverTransport.send(
          'client',
          abortMessage(
            initStreamId,
            Err({
              code: ABORT_CODE,
              message: '',
            }),
          ),
        );

        await expect(resP).resolves.toEqual({
          ok: false,
          payload: {
            code: ABORT_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          },
        });
      });

      test('upload', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = {
          service: ServiceSchema.define({
            upload: Procedure.upload({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              async handler() {
                throw new Error('unimplemented');
              },
            }),
          }),
        };
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const serverOnMessage = vi.fn<[EventMap['message']]>();
        serverTransport.addEventListener('message', serverOnMessage);

        const { reqWriter, finalize } = client.service.upload.upload({});

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(1);
        });

        const initStreamId = serverOnMessage.mock.calls[0][0].streamId;

        serverTransport.send(
          'client',
          abortMessage(
            initStreamId,
            Err({
              code: ABORT_CODE,
              message: '',
            }),
          ),
        );

        await expect(finalize()).resolves.toEqual({
          ok: false,
          payload: {
            code: ABORT_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          },
        });
        expect(reqWriter.isClosed());
      });

      test('stream', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = {
          service: ServiceSchema.define({
            stream: Procedure.stream({
              requestInit: Type.Object({}),
              requestData: Type.Object({}),
              responseData: Type.Object({}),
              async handler() {
                throw new Error('unimplemented');
              },
            }),
          }),
        };
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const serverOnMessage = vi.fn<[EventMap['message']]>();
        serverTransport.addEventListener('message', serverOnMessage);

        const { reqWriter, resReader } = client.service.stream.stream({});

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(1);
        });

        const initStreamId = serverOnMessage.mock.calls[0][0].streamId;

        serverTransport.send(
          'client',
          abortMessage(
            initStreamId,
            Err({
              code: ABORT_CODE,
              message: '',
            }),
          ),
        );

        await expect(resReader.asArray()).resolves.toEqual([
          {
            ok: false,
            payload: {
              code: ABORT_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.any(String),
            },
          },
        ]);
        expect(reqWriter.isClosed());
      });

      test('subscribe', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = {
          service: ServiceSchema.define({
            subscribe: Procedure.subscription({
              requestInit: Type.Object({}),
              responseData: Type.Object({}),
              async handler() {
                throw new Error('unimplemented');
              },
            }),
          }),
        };
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const serverOnMessage = vi.fn<[EventMap['message']]>();
        serverTransport.addEventListener('message', serverOnMessage);

        const { resReader } = client.service.subscribe.subscribe({});

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(1);
        });

        const initStreamId = serverOnMessage.mock.calls[0][0].streamId;

        serverTransport.send(
          'client',
          abortMessage(
            initStreamId,
            Err({
              code: ABORT_CODE,
              message: '',
            }),
          ),
        );

        await expect(resReader.asArray()).resolves.toEqual([
          {
            ok: false,
            payload: {
              code: ABORT_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.any(String),
            },
          },
        ]);
      });
    });

    describe('real server, mock client', () => {
      test.each([
        { procedureType: 'rpc' },
        { procedureType: 'subscription' },
        { procedureType: 'stream' },
        { procedureType: 'upload' },
      ] as const)('$procedureType', async ({ procedureType }) => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const handler = vi.fn<[{ ctx: ProcedureHandlerContext<object> }]>();
        const serviceName = 'service';
        const procedureName = procedureType;

        const services = {
          [serviceName]: ServiceSchema.define({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
            [procedureType]: (Procedure[procedureType] as any)({
              requestInit: Type.Object({}),
              ...(procedureType === 'stream' || procedureType === 'upload'
                ? {
                    requestData: Type.Object({}),
                  }
                : {}),
              responseData: Type.Object({}),
              async handler({ ctx }: { ctx: ProcedureHandlerContext<object> }) {
                handler({ ctx });

                return new Promise(() => {
                  // never resolves
                });
              },
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        clientTransport.connect(serverId);

        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const streamId = nanoid();
        clientTransport.send(serverId, {
          streamId,
          serviceName,
          procedureName,
          payload: {},
          controlFlags:
            ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
        });

        const serverOnMessage = vi.fn<[EventMap['message']]>();
        serverTransport.addEventListener('message', serverOnMessage);

        const clientOnMessage = vi.fn<[EventMap['message']]>();
        clientTransport.addEventListener('message', clientOnMessage);

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(1);
        });

        expect(server.openStreams.size).toEqual(1);
        expect(handler).toHaveBeenCalledTimes(1);
        const [{ ctx }] = handler.mock.calls[0];
        ctx.abortController.abort();

        await waitFor(() => {
          expect(clientOnMessage).toHaveBeenCalledTimes(1);
        });

        expect(clientOnMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            ack: 1,
            controlFlags: ControlFlags.StreamAbortBit,
            streamId,
            payload: {
              ok: false,
              payload: {
                code: ABORT_CODE,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                message: expect.any(String),
              },
            },
          }),
        );

        expect(server.openStreams.size).toEqual(0);
      });

      test('tombstones aborted stream', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        addPostTestCleanup(() =>
          cleanupTransports([clientTransport, serverTransport]),
        );

        const handler = vi
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .fn<Parameters<StreamProcedure<any, any, any, any, any>['handler']>>()
          .mockImplementation(
            () =>
              new Promise(() => {
                // never resolves
              }),
          );
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

        createServer(serverTransport, services);
        clientTransport.connect(serverId);

        const serverSendSpy = vi.spyOn(serverTransport, 'send');

        const serverOnMessage = vi.fn<[EventMap['message']]>();
        serverTransport.addEventListener('message', serverOnMessage);

        const clientOnMessage = vi.fn<[EventMap['message']]>();
        clientTransport.addEventListener('message', clientOnMessage);

        const streamId = nanoid();
        clientTransport.send(serverId, {
          streamId,
          serviceName: 'service',
          procedureName: 'stream',
          payload: {},
          controlFlags: ControlFlags.StreamOpenBit,
        });

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx }] = handler.mock.calls[0];
        ctx.abortController.abort();
        // input for the stream should be ignored
        // instead of leading to an error response
        clientTransport.send(serverId, {
          streamId,
          payload: {},
          controlFlags: 0,
        });

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(2);
        });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(serverSendSpy).toHaveBeenCalledWith('client', {
          streamId,
          controlFlags: ControlFlags.StreamAbortBit,
          payload: {
            ok: false,
            payload: {
              code: ABORT_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.any(String),
            },
          },
        });

        await waitFor(() => {
          expect(clientOnMessage).toHaveBeenCalledTimes(1);
        });

        expect(clientOnMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            ack: 1,
            controlFlags: ControlFlags.StreamAbortBit,
            streamId,
            payload: {
              ok: false,
              payload: {
                code: ABORT_CODE,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                message: expect.any(String),
              },
            },
          }),
        );
      });
    });

    describe('e2e', () => {
      // testing stream only e2e as it's the most general case
      test('stream', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const handler = vi
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .fn<Parameters<StreamProcedure<any, any, any, any, any>['handler']>>()
          .mockImplementation(
            () =>
              new Promise(() => {
                // never resolves
              }),
          );
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
        createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { reqWriter, resReader } = client.service.stream.stream({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ ctx, reqReader, resWriter }] = handler.mock.calls[0];

        ctx.abortController.abort();
        // this should be ignored by the server since it already aborted
        reqWriter.write({ ok: true, payload: {} });
        expect(await reqReader.asArray()).toEqual([
          {
            ok: false,
            payload: {
              code: ABORT_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.any(String),
            },
          },
        ]);
        expect(reqReader.isClosed());
        expect(resWriter.isClosed());

        expect(await resReader.asArray()).toEqual([
          {
            ok: false,
            payload: {
              code: ABORT_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.any(String),
            },
          },
        ]);
        expect(resReader.isClosed());
        expect(reqWriter.isClosed());
      });
    });
  },
);

const createRejectable = () => {
  let reject: (reason: Error) => void;
  const promise = new Promise((_res, rej) => {
    reject = rej;
  });

  // @ts-expect-error promises callback are invoked immediately
  return { promise, reject };
};

describe.each(testMatrix())(
  'handler uncaught exception error abort ($transport.name transport, $codec.name codec)',
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

    describe('real server, mock client', () => {
      test.each([
        { procedureType: 'rpc' },
        { procedureType: 'subscription' },
        { procedureType: 'stream' },
        { procedureType: 'upload' },
      ] as const)('$procedureType', async ({ procedureType }) => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();

        const serviceName = 'service';
        const procedureName = procedureType;

        const rejectable = createRejectable();
        const services = {
          [serviceName]: ServiceSchema.define({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
            [procedureType]: (Procedure[procedureType] as any)({
              requestInit: Type.Object({}),
              ...(procedureType === 'stream' || procedureType === 'upload'
                ? {
                    requestData: Type.Object({}),
                  }
                : {}),
              responseData: Type.Object({}),
              async handler() {
                return rejectable.promise;
              },
            }),
          }),
        };

        const server = createServer(serverTransport, services);
        clientTransport.connect(serverId);

        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const streamId = nanoid();
        clientTransport.send(serverId, {
          streamId,
          serviceName,
          procedureName,
          payload: {},
          controlFlags:
            ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
        });

        const serverOnMessage = vi.fn<[EventMap['message']]>();
        serverTransport.addEventListener('message', serverOnMessage);

        const clientOnMessage = vi.fn<[EventMap['message']]>();
        clientTransport.addEventListener('message', clientOnMessage);

        await waitFor(() => {
          expect(serverOnMessage).toHaveBeenCalledTimes(1);
        });

        expect(server.openStreams.size).toEqual(1);
        const errorMessage = Math.random().toString();
        rejectable.reject(new Error(errorMessage));

        await waitFor(() => {
          expect(clientOnMessage).toHaveBeenCalledTimes(1);
        });

        expect(clientOnMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            ack: 1,
            controlFlags: ControlFlags.StreamAbortBit,
            streamId,
            payload: {
              ok: false,
              payload: {
                code: UNCAUGHT_ERROR_CODE,
                message: errorMessage,
              },
            },
          }),
        );

        expect(server.openStreams.size).toEqual(0);
      });
    });

    describe('e2e', () => {
      // testing stream only e2e as it's the most general case
      test('stream', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const rejectable = createRejectable();
        const handler = vi
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .fn<Parameters<StreamProcedure<any, any, any, any, any>['handler']>>()
          .mockImplementation(() => rejectable.promise);
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
        createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );

        const { reqWriter, resReader } = client.service.stream.stream({});

        await waitFor(() => {
          expect(handler).toHaveBeenCalledTimes(1);
        });

        const [{ reqReader, resWriter }] = handler.mock.calls[0];

        const errorMessage = Math.random().toString();
        rejectable.reject(new Error(errorMessage));
        // this should be ignored by the server since it already aborted
        reqWriter.write({ ok: true, payload: {} });
        expect(await reqReader.asArray()).toEqual([
          {
            ok: false,
            payload: {
              code: UNCAUGHT_ERROR_CODE,
              message: errorMessage,
            },
          },
        ]);
        expect(reqReader.isClosed());
        expect(resWriter.isClosed());

        expect(await resReader.asArray()).toEqual([
          {
            ok: false,
            payload: {
              code: UNCAUGHT_ERROR_CODE,
              message: errorMessage,
            },
          },
        ]);
        expect(resReader.isClosed());
        expect(reqWriter.isClosed());
      });
    });
  },
);
