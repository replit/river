import { Type } from '@sinclair/typebox';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
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
import { INVALID_REQUEST_CODE } from '../router/procedures';
import { ControlFlags } from '../transport/message';
import { TestSetupHelpers } from './fixtures/transports';
import { nanoid } from 'nanoid';

describe('aborts invalid request', () => {
  const { transport, codec } = testMatrix()[0];
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

  test('missing StreamOpenBit', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = 'SERVER';

    const services = {
      service: ServiceSchema.define({
        stream: Procedure.stream({
          init: Type.Object({}),
          input: Type.Object({}),
          output: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);

    const streamId = nanoid();
    clientTransport.send(serverId, {
      streamId,
      serviceName: 'service',
      procedureName: 'stream',
      payload: {},
      controlFlags: 0,
    });

    const clientOnMessage = vi.fn<[EventMap['message']]>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamAbortBit,
          streamId,
          payload: {
            ok: false,
            payload: {
              code: INVALID_REQUEST_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.stringContaining('stream open bit'),
            },
          },
        }),
      );
    });
  });

  test('missing serviceName', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = 'SERVER';

    const services = {
      service: ServiceSchema.define({
        stream: Procedure.stream({
          init: Type.Object({}),
          input: Type.Object({}),
          output: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);

    const streamId = nanoid();
    clientTransport.send(serverId, {
      streamId,
      procedureName: 'stream',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    const clientOnMessage = vi.fn<[EventMap['message']]>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamAbortBit,
          streamId,
          payload: {
            ok: false,
            payload: {
              code: INVALID_REQUEST_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.stringContaining('service name'),
            },
          },
        }),
      );
    });
  });

  test('missing procedureName', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = 'SERVER';

    const services = {
      service: ServiceSchema.define({
        stream: Procedure.stream({
          init: Type.Object({}),
          input: Type.Object({}),
          output: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);

    const streamId = nanoid();
    clientTransport.send(serverId, {
      streamId,
      serviceName: 'service',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    const clientOnMessage = vi.fn<[EventMap['message']]>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamAbortBit,
          streamId,
          payload: {
            ok: false,
            payload: {
              code: INVALID_REQUEST_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.stringContaining('procedure name'),
            },
          },
        }),
      );
    });
  });

  test('service does not exist', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = 'SERVER';

    const services = {
      service: ServiceSchema.define({
        stream: Procedure.stream({
          init: Type.Object({}),
          input: Type.Object({}),
          output: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);

    const streamId = nanoid();
    clientTransport.send(serverId, {
      streamId,
      serviceName: 'serviceDoesNotExist',
      procedureName: 'stream',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    const clientOnMessage = vi.fn<[EventMap['message']]>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamAbortBit,
          streamId,
          payload: {
            ok: false,
            payload: {
              code: INVALID_REQUEST_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.stringContaining('find service'),
            },
          },
        }),
      );
    });
  });

  test('procedure does not exist', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = 'SERVER';

    const services = {
      service: ServiceSchema.define({
        stream: Procedure.stream({
          init: Type.Object({}),
          input: Type.Object({}),
          output: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);

    const streamId = nanoid();
    clientTransport.send(serverId, {
      streamId,
      serviceName: 'service',
      procedureName: 'procedureDoesNotExist',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    const clientOnMessage = vi.fn<[EventMap['message']]>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledTimes(1);
    });

    expect(clientOnMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        controlFlags: ControlFlags.StreamAbortBit,
        streamId,
        payload: {
          ok: false,
          payload: {
            code: INVALID_REQUEST_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.stringContaining('matching procedure'),
          },
        },
      }),
    );
  });

  test('bad init message', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = 'SERVER';

    const services = {
      service: ServiceSchema.define({
        stream: Procedure.stream({
          init: Type.Object({ mustSendThings: Type.String() }),
          input: Type.Object({}),
          output: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);

    const streamId = nanoid();
    clientTransport.send(serverId, {
      streamId,
      serviceName: 'service',
      procedureName: 'stream',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    const clientOnMessage = vi.fn<[EventMap['message']]>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamAbortBit,
          streamId,
          payload: {
            ok: false,
            payload: {
              code: INVALID_REQUEST_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.stringContaining('init failed validation'),
            },
          },
        }),
      );
    });
  });

  test('bad input message', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = 'SERVER';

    const services = {
      service: ServiceSchema.define({
        stream: Procedure.stream({
          init: Type.Object({}),
          input: Type.Object({ mustSendThings: Type.String() }),
          output: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);

    const streamId = nanoid();
    clientTransport.send(serverId, {
      streamId,
      serviceName: 'service',
      procedureName: 'stream',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    clientTransport.send(serverId, {
      streamId,
      payload: {},
      controlFlags: 0,
    });

    const clientOnMessage = vi.fn<[EventMap['message']]>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledTimes(1);
    });

    expect(clientOnMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        controlFlags: ControlFlags.StreamAbortBit,
        streamId,
        payload: {
          ok: false,
          payload: {
            code: INVALID_REQUEST_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.stringContaining(
              'input payload, validation failed',
            ),
          },
        },
      }),
    );
  });

  test('input message for non-input procedure', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = 'SERVER';

    const services = {
      service: ServiceSchema.define({
        rpc: Procedure.rpc({
          init: Type.Object({}),
          output: Type.Object({}),
          handler: async () => ({ ok: true, payload: {} }),
        }),
      }),
    };

    createServer(serverTransport, services);

    const streamId = nanoid();
    clientTransport.send(serverId, {
      streamId,
      serviceName: 'service',
      procedureName: 'rpc',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    clientTransport.send(serverId, {
      streamId,
      payload: { wat: '1' },
      controlFlags: 0,
    });

    const clientOnMessage = vi.fn<[EventMap['message']]>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledTimes(1);
    });

    expect(clientOnMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        controlFlags: ControlFlags.StreamAbortBit,
        streamId,
        payload: {
          ok: false,
          payload: {
            code: INVALID_REQUEST_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.stringContaining('control payload'),
          },
        },
      }),
    );
  });

  test('input after close', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = 'SERVER';

    const services = {
      service: ServiceSchema.define({
        stream: Procedure.stream({
          init: Type.Object({}),
          input: Type.Object({}),
          output: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);

    const streamId = nanoid();
    clientTransport.send(serverId, {
      streamId,
      serviceName: 'service',
      procedureName: 'stream',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    clientTransport.send(serverId, {
      streamId,
      payload: {},
      controlFlags: ControlFlags.StreamClosedBit,
    });

    clientTransport.send(serverId, {
      streamId,
      payload: {},
      controlFlags: 0,
    });

    const clientOnMessage = vi.fn<[EventMap['message']]>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamAbortBit,
          streamId,
          payload: {
            ok: false,
            payload: {
              code: INVALID_REQUEST_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.stringContaining('stream is closed'),
            },
          },
        }),
      );
    });
  });

  // things that can happen with a real client and
  // backwards incompatible server changes
  test('e2e', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = 'SERVER';

    const services = {
      service: ServiceSchema.define({
        rpc: Procedure.rpc({
          init: Type.Object({}),
          output: Type.Object({}),
          handler: async () => ({ ok: true, payload: {} }),
        }),
        stream: Procedure.stream({
          init: Type.Object({}),
          input: Type.Object({ oldField: Type.String() }),
          output: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);

    const client = createClient<typeof services>(clientTransport, serverId);

    // @ts-expect-error monkey-patched incompatible change :D
    delete services.service.procedures.rpc;

    expect(await client.service.rpc.rpc({})).toEqual({
      ok: false,
      payload: {
        code: INVALID_REQUEST_CODE,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        message: expect.stringContaining('matching procedure'),
      },
    });

    // @ts-expect-error monkey-patched incompatible change :D
    services.service.procedures.stream.input = Type.Object({
      newRequiredField: Type.String(),
    });

    const [inputWriter, outputReader] = client.service.stream.stream({});

    inputWriter.write({ oldField: 'heyyo' });
    expect(await outputReader.asArray()).toEqual([
      {
        ok: false,
        payload: {
          code: INVALID_REQUEST_CODE,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          message: expect.stringContaining('input payload, validation'),
        },
      },
    ]);
  });

  describe('tombestones invalid request', () => {
    test('responds to multiple invalid requests for the same stream only once', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      addPostTestCleanup(() =>
        cleanupTransports([clientTransport, serverTransport]),
      );
      const serverId = 'SERVER';

      const services = {
        service: ServiceSchema.define({
          stream: Procedure.stream({
            init: Type.Object({}),
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async () => undefined,
          }),
        }),
      };

      createServer(serverTransport, services);

      const serverSendAbortSpy = vi.spyOn(serverTransport, 'sendAbort');

      const streamId = nanoid();
      clientTransport.send(serverId, {
        streamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });
      clientTransport.send(serverId, {
        streamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });
      clientTransport.send(serverId, {
        streamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      await waitFor(() => {
        expect(serverSendAbortSpy).toHaveBeenCalledTimes(1);
      });

      const anotherStreamId = nanoid();
      clientTransport.send(serverId, {
        streamId: anotherStreamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      await waitFor(() => {
        expect(serverSendAbortSpy).toHaveBeenCalledTimes(2);
      });

      expect(serverSendAbortSpy).toHaveBeenNthCalledWith(
        1,
        'client',
        streamId,
        {
          ok: false,
          payload: {
            code: INVALID_REQUEST_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.stringContaining('missing service name'),
          },
        },
      );

      expect(serverSendAbortSpy).toHaveBeenNthCalledWith(
        2,
        'client',
        anotherStreamId,
        {
          ok: false,
          payload: {
            code: INVALID_REQUEST_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.stringContaining('missing service name'),
          },
        },
      );
    });

    test('starts responding to same stream after tombstones are evicted', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      addPostTestCleanup(() =>
        cleanupTransports([clientTransport, serverTransport]),
      );
      const serverId = 'SERVER';

      const services = {
        service: ServiceSchema.define({
          stream: Procedure.stream({
            init: Type.Object({}),
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async () => undefined,
          }),
        }),
      };

      const maxAbortedStreamTombstonesPerSession = 5;
      createServer(serverTransport, services, {
        maxAbortedStreamTombstonesPerSession,
      });

      const serverSendAbortSpy = vi.spyOn(serverTransport, 'sendAbort');

      const firstStreamId = nanoid();
      clientTransport.send(serverId, {
        streamId: firstStreamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      await waitFor(() => {
        expect(serverSendAbortSpy).toHaveBeenCalledTimes(1);
      });

      expect(serverSendAbortSpy).toHaveBeenNthCalledWith(
        1,
        'client',
        firstStreamId,
        {
          ok: false,
          payload: {
            code: INVALID_REQUEST_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.stringContaining('missing service name'),
          },
        },
      );

      for (let i = 0; i < maxAbortedStreamTombstonesPerSession; i++) {
        clientTransport.send(serverId, {
          streamId: nanoid(), // new streams
          procedureName: 'stream',
          payload: {},
          controlFlags: ControlFlags.StreamOpenBit,
        });
      }

      await waitFor(() => {
        expect(serverSendAbortSpy).toHaveBeenCalledTimes(
          maxAbortedStreamTombstonesPerSession + 1,
        );
      });

      clientTransport.send(serverId, {
        streamId: firstStreamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      await waitFor(() => {
        expect(serverSendAbortSpy).toHaveBeenCalledTimes(
          maxAbortedStreamTombstonesPerSession + 2,
        );
      });

      expect(serverSendAbortSpy).toHaveBeenNthCalledWith(
        maxAbortedStreamTombstonesPerSession + 2,
        'client',
        firstStreamId,
        {
          ok: false,
          payload: {
            code: INVALID_REQUEST_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.stringContaining('missing service name'),
          },
        },
      );
    });

    test("separate sessions don't evict tombstones", async () => {
      const client1Transport = getClientTransport('client1');
      const client2Transport = getClientTransport('client2');
      const serverTransport = getServerTransport();
      addPostTestCleanup(() =>
        cleanupTransports([
          client1Transport,
          client2Transport,
          serverTransport,
        ]),
      );
      const serverId = 'SERVER';

      const services = {
        service: ServiceSchema.define({
          stream: Procedure.stream({
            init: Type.Object({}),
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async () => undefined,
          }),
        }),
      };

      const maxAbortedStreamTombstonesPerSession = 5;
      createServer(serverTransport, services, {
        maxAbortedStreamTombstonesPerSession,
      });

      const serverSendAbortSpy = vi.spyOn(serverTransport, 'sendAbort');

      const client1FirstStreamId = nanoid();
      client1Transport.send(serverId, {
        streamId: client1FirstStreamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      for (let i = 0; i < maxAbortedStreamTombstonesPerSession; i++) {
        client2Transport.send(serverId, {
          streamId: nanoid(), // new streams
          procedureName: 'stream',
          payload: {},
          controlFlags: ControlFlags.StreamOpenBit,
        });
      }

      await waitFor(() => {
        expect(serverSendAbortSpy).toHaveBeenCalledTimes(
          maxAbortedStreamTombstonesPerSession + 1,
        );
      });

      // server should ignore this
      client1Transport.send(serverId, {
        streamId: client1FirstStreamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      const client1LastStreamId = nanoid();
      client1Transport.send(serverId, {
        streamId: client1LastStreamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      await waitFor(() => {
        expect(serverSendAbortSpy).toHaveBeenCalledTimes(
          maxAbortedStreamTombstonesPerSession + 2,
        );
      });

      expect(serverSendAbortSpy).toHaveBeenNthCalledWith(
        maxAbortedStreamTombstonesPerSession + 2,
        'client1',
        client1LastStreamId,
        {
          ok: false,
          payload: {
            code: INVALID_REQUEST_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.stringContaining('missing service name'),
          },
        },
      );
    });
  });
});