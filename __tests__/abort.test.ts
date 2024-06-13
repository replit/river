import { Type } from '@sinclair/typebox';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Procedure, ServiceSchema, createClient } from '../router';
import { testMatrix } from './fixtures/matrix';
import {
  cleanupTransports,
  createPostTestCleanups,
  waitFor,
} from './fixtures/cleanup';
import { EventMap } from '../transport';
import { ABORT_CODE } from '../router/procedures';
import { ControlFlags } from '../transport/message';
import { TestSetupHelpers } from './fixtures/transports';

describe.each(testMatrix())(
  'client initiated abort, client tests ($transport.name transport, $codec.name codec)',
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

    test('rpc', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        service: ServiceSchema.define({
          rpc: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({}),
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
            init: Type.Object({}),
            input: Type.Object({}),
            output: Type.Object({}),
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
      const [inputWriter, finalize] = client.service.upload.upload(
        {},
        { signal },
      );

      await waitFor(() => {
        expect(serverOnMessage).toHaveBeenCalledTimes(1);
      });

      abortController.abort();

      expect(inputWriter.isClosed());
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
            init: Type.Object({}),
            output: Type.Object({}),
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
      const outputReader = client.service.subscribe.subscribe({}, { signal });

      await waitFor(() => {
        expect(serverOnMessage).toHaveBeenCalledTimes(1);
      });

      abortController.abort();

      expect(outputReader.isClosed());
      await expect(outputReader.asArray()).resolves.toEqual([
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
            init: Type.Object({}),
            input: Type.Object({}),
            output: Type.Object({}),
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
      const [inputWriter, outputReader] = client.service.stream.stream(
        {},
        { signal },
      );

      await waitFor(() => {
        expect(serverOnMessage).toHaveBeenCalledTimes(1);
      });

      abortController.abort();

      expect(outputReader.isClosed());
      expect(inputWriter.isClosed());
      await expect(outputReader.asArray()).resolves.toEqual([
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
  },
);

describe.each(testMatrix())(
  'server initiated abort, client tests ($transport.name transport, $codec.name codec)',
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

    test('rpc', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        service: ServiceSchema.define({
          rpc: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({}),
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

      serverTransport.sendAbort('client', initStreamId);

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
            init: Type.Object({}),
            input: Type.Object({}),
            output: Type.Object({}),
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

      const [inputWriter, finalize] = client.service.upload.upload({});

      await waitFor(() => {
        expect(serverOnMessage).toHaveBeenCalledTimes(1);
      });

      const initStreamId = serverOnMessage.mock.calls[0][0].streamId;

      serverTransport.sendAbort('client', initStreamId);

      await expect(finalize()).resolves.toEqual({
        ok: false,
        payload: {
          code: ABORT_CODE,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          message: expect.any(String),
        },
      });
      expect(inputWriter.isClosed());
    });

    test('stream', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        service: ServiceSchema.define({
          stream: Procedure.stream({
            init: Type.Object({}),
            input: Type.Object({}),
            output: Type.Object({}),
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

      const [inputWriter, outputReader] = client.service.stream.stream({});

      await waitFor(() => {
        expect(serverOnMessage).toHaveBeenCalledTimes(1);
      });

      const initStreamId = serverOnMessage.mock.calls[0][0].streamId;

      serverTransport.sendAbort('client', initStreamId);

      await expect(outputReader.asArray()).resolves.toEqual([
        {
          ok: false,
          payload: {
            code: ABORT_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.any(String),
          },
        },
      ]);
      expect(inputWriter.isClosed());
    });

    test('subscribe', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        service: ServiceSchema.define({
          subscribe: Procedure.subscription({
            init: Type.Object({}),
            output: Type.Object({}),
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

      const outputReader = client.service.subscribe.subscribe({});

      await waitFor(() => {
        expect(serverOnMessage).toHaveBeenCalledTimes(1);
      });

      const initStreamId = serverOnMessage.mock.calls[0][0].streamId;

      serverTransport.sendAbort('client', initStreamId);

      await expect(outputReader.asArray()).resolves.toEqual([
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
  },
);
