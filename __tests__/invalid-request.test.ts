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
import { getClientSendFn } from '../util/testHelpers';

describe('cancels invalid request', () => {
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
    const serverId = serverTransport.clientId;

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
    const clientSendFn = getClientSendFn(clientTransport, serverTransport);

    const streamId = nanoid();
    clientSendFn({
      streamId,
      serviceName: 'service',
      procedureName: 'stream',
      payload: {},
      controlFlags: 0,
    });

    const clientOnMessage = vi.fn<(msg: EventMap['message']) => void>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamCancelBit,
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
    const serverId = serverTransport.clientId;

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
    const clientSendFn = getClientSendFn(clientTransport, serverTransport);

    const streamId = nanoid();
    clientSendFn({
      streamId,
      procedureName: 'stream',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    const clientOnMessage = vi.fn<(msg: EventMap['message']) => void>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamCancelBit,
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
    const serverId = serverTransport.clientId;

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
    const clientSendFn = getClientSendFn(clientTransport, serverTransport);

    const streamId = nanoid();
    clientSendFn({
      streamId,
      serviceName: 'service',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    const clientOnMessage = vi.fn<(msg: EventMap['message']) => void>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamCancelBit,
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
    const serverId = serverTransport.clientId;

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
    const clientSendFn = getClientSendFn(clientTransport, serverTransport);

    const streamId = nanoid();
    clientSendFn({
      streamId,
      serviceName: 'serviceDoesNotExist',
      procedureName: 'stream',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    const clientOnMessage = vi.fn<(msg: EventMap['message']) => void>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamCancelBit,
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
    const serverId = serverTransport.clientId;

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
    const clientSendFn = getClientSendFn(clientTransport, serverTransport);

    const streamId = nanoid();
    clientSendFn({
      streamId,
      serviceName: 'service',
      procedureName: 'procedureDoesNotExist',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    const clientOnMessage = vi.fn<(msg: EventMap['message']) => void>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledTimes(1);
    });

    expect(clientOnMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        controlFlags: ControlFlags.StreamCancelBit,
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
    const serverId = serverTransport.clientId;

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
    const clientSendFn = getClientSendFn(clientTransport, serverTransport);

    const streamId = nanoid();
    clientSendFn({
      streamId,
      serviceName: 'service',
      procedureName: 'stream',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    const clientOnMessage = vi.fn<(msg: EventMap['message']) => void>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamCancelBit,
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

  test('bad request message', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = serverTransport.clientId;

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
    const clientSendFn = getClientSendFn(clientTransport, serverTransport);

    const streamId = nanoid();
    clientSendFn({
      streamId,
      serviceName: 'service',
      procedureName: 'stream',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    clientSendFn({
      streamId,
      payload: {},
      controlFlags: 0,
    });

    const clientOnMessage = vi.fn<(msg: EventMap['message']) => void>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledTimes(1);
    });

    expect(clientOnMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        controlFlags: ControlFlags.StreamCancelBit,
        streamId,
        payload: {
          ok: false,
          payload: {
            code: INVALID_REQUEST_CODE,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            message: expect.stringContaining(
              'expected requestData or control payload',
            ),
          },
        },
      }),
    );
  });

  test('request message for non-request procedure', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = serverTransport.clientId;

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
    const clientSendFn = getClientSendFn(clientTransport, serverTransport);

    const streamId = nanoid();
    clientSendFn({
      streamId,
      serviceName: 'service',
      procedureName: 'rpc',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    clientSendFn({
      streamId,
      payload: { wat: '1' },
      controlFlags: 0,
    });

    const clientOnMessage = vi.fn<(msg: EventMap['message']) => void>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledTimes(1);
    });

    expect(clientOnMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        controlFlags: ControlFlags.StreamCancelBit,
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

  test('request after close', async () => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    addPostTestCleanup(() =>
      cleanupTransports([clientTransport, serverTransport]),
    );
    const serverId = serverTransport.clientId;

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
    const clientSendFn = getClientSendFn(clientTransport, serverTransport);

    const streamId = nanoid();
    clientSendFn({
      streamId,
      serviceName: 'service',
      procedureName: 'stream',
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    clientSendFn({
      streamId,
      payload: {},
      controlFlags: ControlFlags.StreamClosedBit,
    });

    clientSendFn({
      streamId,
      payload: {},
      controlFlags: 0,
    });

    const clientOnMessage = vi.fn<(msg: EventMap['message']) => void>();
    clientTransport.addEventListener('message', clientOnMessage);

    await waitFor(() => {
      expect(clientOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          controlFlags: ControlFlags.StreamCancelBit,
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
    const serverId = serverTransport.clientId;

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
          message: expect.stringContaining(
            'expected requestData or control payload',
          ),
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
      const serverId = serverTransport.clientId;

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

      const serverSendSpy = vi.spyOn(serverTransport, 'send');

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
        expect(serverSendSpy).toHaveBeenCalledWith('client', {
          streamId,
          controlFlags: ControlFlags.StreamCancelBit,
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
        expect(serverSendSpy).toHaveBeenCalledWith('client', {
          streamId: anotherStreamId,
          controlFlags: ControlFlags.StreamCancelBit,
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

      expect(serverSendSpy).toHaveBeenCalledTimes(2);
    });

    test('starts responding to same stream after tombstones are evicted', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      addPostTestCleanup(() =>
        cleanupTransports([clientTransport, serverTransport]),
      );
      const serverId = serverTransport.clientId;

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

      const maxCancelledStreamTombstonesPerSession = 5;
      createServer(serverTransport, services, {
        maxCancelledStreamTombstonesPerSession,
      });
      clientTransport.connect(serverId);

      const serverSendSpy = vi.spyOn(serverTransport, 'send');

      const firstStreamId = nanoid();
      clientTransport.send(serverId, {
        streamId: firstStreamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      await waitFor(() => {
        expect(serverSendSpy).toHaveBeenNthCalledWith(1, 'client', {
          streamId: firstStreamId,
          controlFlags: ControlFlags.StreamCancelBit,
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

      for (let i = 0; i < maxCancelledStreamTombstonesPerSession; i++) {
        clientTransport.send(serverId, {
          streamId: nanoid(), // new streams
          procedureName: 'stream',
          payload: {},
          controlFlags: ControlFlags.StreamOpenBit,
        });
      }

      await waitFor(() => {
        expect(serverSendSpy).toHaveBeenCalledTimes(
          maxCancelledStreamTombstonesPerSession + 1,
        );
      });

      clientTransport.send(serverId, {
        streamId: firstStreamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      await waitFor(() => {
        expect(serverSendSpy).toHaveBeenCalledTimes(
          maxCancelledStreamTombstonesPerSession + 2,
        );
      });

      expect(serverSendSpy).toHaveBeenNthCalledWith(
        maxCancelledStreamTombstonesPerSession + 2,
        'client',
        {
          streamId: firstStreamId,
          controlFlags: ControlFlags.StreamCancelBit,
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
      const serverId = serverTransport.clientId;

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

      const maxCancelledStreamTombstonesPerSession = 5;
      createServer(serverTransport, services, {
        maxCancelledStreamTombstonesPerSession,
      });
      client1Transport.connect(serverId);
      client2Transport.connect(serverId);

      const serverSendSpy = vi.spyOn(serverTransport, 'send');

      const client1FirstStreamId = nanoid();
      client1Transport.send(serverId, {
        streamId: client1FirstStreamId,
        procedureName: 'stream',
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      for (let i = 0; i < maxCancelledStreamTombstonesPerSession; i++) {
        client2Transport.send(serverId, {
          streamId: nanoid(), // new streams
          procedureName: 'stream',
          payload: {},
          controlFlags: ControlFlags.StreamOpenBit,
        });
      }

      await waitFor(() => {
        expect(serverSendSpy).toHaveBeenCalledTimes(
          maxCancelledStreamTombstonesPerSession + 1,
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
        expect(serverSendSpy).toHaveBeenCalledTimes(
          maxCancelledStreamTombstonesPerSession + 2,
        );
      });

      expect(serverSendSpy).toHaveBeenNthCalledWith(
        maxCancelledStreamTombstonesPerSession + 2,
        'client1',
        {
          streamId: client1LastStreamId,
          controlFlags: ControlFlags.StreamCancelBit,
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
