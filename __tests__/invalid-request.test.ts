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
          requestInit: Type.Object({}),
          requestData: Type.Object({}),
          responseData: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);
    clientTransport.connect(serverId);

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
          requestInit: Type.Object({}),
          requestData: Type.Object({}),
          responseData: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);
    clientTransport.connect(serverId);

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
          requestInit: Type.Object({}),
          requestData: Type.Object({}),
          responseData: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);
    clientTransport.connect(serverId);

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
          requestInit: Type.Object({}),
          requestData: Type.Object({}),
          responseData: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);
    clientTransport.connect(serverId);

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
          requestInit: Type.Object({}),
          requestData: Type.Object({}),
          responseData: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);
    clientTransport.connect(serverId);

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
          requestInit: Type.Object({ mustSendThings: Type.String() }),
          requestData: Type.Object({}),
          responseData: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);
    clientTransport.connect(serverId);

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
          requestInit: Type.Object({}),
          requestData: Type.Object({ mustSendThings: Type.String() }),
          responseData: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);
    clientTransport.connect(serverId);

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
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          handler: async () => ({ ok: true, payload: {} }),
        }),
      }),
    };

    createServer(serverTransport, services);
    clientTransport.connect(serverId);

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
          requestInit: Type.Object({}),
          requestData: Type.Object({}),
          responseData: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);
    clientTransport.connect(serverId);

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
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          handler: async () => ({ ok: true, payload: {} }),
        }),
        stream: Procedure.stream({
          requestInit: Type.Object({}),
          requestData: Type.Object({ oldField: Type.String() }),
          responseData: Type.Object({}),
          handler: async () => undefined,
        }),
      }),
    };

    createServer(serverTransport, services);
    clientTransport.connect(serverId);

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
    services.service.procedures.stream.requestData = Type.Object({
      newRequiredField: Type.String(),
    });

    const { reqWritable, resReadable } = client.service.stream.stream({});

    reqWritable.write({ oldField: 'heyyo' });
    expect(await resReadable.collect()).toEqual([
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
            requestInit: Type.Object({}),
            requestData: Type.Object({}),
            responseData: Type.Object({}),
            handler: async () => undefined,
          }),
        }),
      };

      createServer(serverTransport, services);
      clientTransport.connect(serverId);

      const sendSpy = vi.spyOn(serverTransport, 'send');

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
        expect(sendSpy).toHaveBeenCalledWith('client', {
          streamId,
          controlFlags: ControlFlags.StreamAbortBit,
          payload: {
            ok: false,
            payload: {
              code: INVALID_REQUEST_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.stringContaining('missing service name'),
            },
          },
        });
      });

      const anotherStreamId = nanoid();
      clientTransport.send(serverId, {
        streamId: anotherStreamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      await waitFor(() => {
        expect(sendSpy).toHaveBeenCalledWith('client', {
          streamId: anotherStreamId,
          controlFlags: ControlFlags.StreamAbortBit,
          payload: {
            ok: false,
            payload: {
              code: INVALID_REQUEST_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.stringContaining('missing service name'),
            },
          },
        });
      });

      expect(sendSpy).toHaveBeenCalledTimes(2);
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
            requestInit: Type.Object({}),
            requestData: Type.Object({}),
            responseData: Type.Object({}),
            handler: async () => undefined,
          }),
        }),
      };

      const maxAbortedStreamTombstonesPerSession = 5;
      createServer(serverTransport, services, {
        maxAbortedStreamTombstonesPerSession,
      });
      clientTransport.connect(serverId);

      const sendSpy = vi.spyOn(serverTransport, 'send');

      const firstStreamId = nanoid();
      clientTransport.send(serverId, {
        streamId: firstStreamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      await waitFor(() => {
        expect(sendSpy).toHaveBeenNthCalledWith(1, 'client', {
          streamId: firstStreamId,
          controlFlags: ControlFlags.StreamAbortBit,
          payload: {
            ok: false,
            payload: {
              code: INVALID_REQUEST_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.stringContaining('missing service name'),
            },
          },
        });
      });

      for (let i = 0; i < maxAbortedStreamTombstonesPerSession; i++) {
        clientTransport.send(serverId, {
          streamId: nanoid(), // new streams
          procedureName: 'stream',
          payload: {},
          controlFlags: ControlFlags.StreamOpenBit,
        });
      }

      await waitFor(() => {
        expect(sendSpy).toHaveBeenCalledTimes(
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
        expect(sendSpy).toHaveBeenCalledTimes(
          maxAbortedStreamTombstonesPerSession + 2,
        );
      });

      expect(sendSpy).toHaveBeenNthCalledWith(
        maxAbortedStreamTombstonesPerSession + 2,
        'client',
        {
          streamId: firstStreamId,
          controlFlags: ControlFlags.StreamAbortBit,
          payload: {
            ok: false,
            payload: {
              code: INVALID_REQUEST_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.stringContaining('missing service name'),
            },
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
            requestInit: Type.Object({}),
            requestData: Type.Object({}),
            responseData: Type.Object({}),
            handler: async () => undefined,
          }),
        }),
      };

      const maxAbortedStreamTombstonesPerSession = 5;
      createServer(serverTransport, services, {
        maxAbortedStreamTombstonesPerSession,
      });
      client1Transport.connect(serverId);
      client2Transport.connect(serverId);

      const sendSpy = vi.spyOn(serverTransport, 'send');

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
        expect(sendSpy).toHaveBeenCalledTimes(
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
        expect(sendSpy).toHaveBeenCalledTimes(
          maxAbortedStreamTombstonesPerSession + 2,
        );
      });

      expect(sendSpy).toHaveBeenNthCalledWith(
        maxAbortedStreamTombstonesPerSession + 2,
        'client1',
        {
          streamId: client1LastStreamId,
          controlFlags: ControlFlags.StreamAbortBit,
          payload: {
            ok: false,
            payload: {
              code: INVALID_REQUEST_CODE,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              message: expect.stringContaining('missing service name'),
            },
          },
        },
      );
    });
  });
});
