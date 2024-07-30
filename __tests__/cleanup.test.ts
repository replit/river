import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  closeAllConnections,
  getIteratorFromStream,
  iterNext,
  numberOfConnections,
} from '../util/testHelpers';
import {
  SubscribableServiceSchema,
  TestServiceSchema,
  UploadableServiceSchema,
} from './fixtures/services';
import {
  Procedure,
  ProcedureHandlerContext,
  ServiceSchema,
  createClient,
  createServer,
} from '../router';
import {
  advanceFakeTimersByHeartbeat,
  advanceFakeTimersBySessionGrace,
  cleanupTransports,
  createPostTestCleanups,
  testFinishesCleanly,
  waitFor,
} from './fixtures/cleanup';
import { testMatrix } from './fixtures/matrix';
import { TestSetupHelpers } from './fixtures/transports';
import { ControlFlags } from '../transport/message';
import { Type } from '@sinclair/typebox';
import { nanoid } from 'nanoid';

describe.each(testMatrix())(
  'procedures should clean up after themselves ($transport.name transport, $codec.name codec)',
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

    test('closing a transport from the client cleans up connection on the server', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      expect(numberOfConnections(clientTransport)).toEqual(0);
      expect(numberOfConnections(serverTransport)).toEqual(0);

      // start procedure
      await client.test.add.rpc({ n: 3 });
      // end procedure

      expect(numberOfConnections(clientTransport)).toEqual(1);
      expect(numberOfConnections(serverTransport)).toEqual(1);

      // wait for send buffers to be flushed
      await advanceFakeTimersByHeartbeat();
      await waitFor(() =>
        expect(
          serverTransport.sessions.get(clientTransport.clientId)?.sendBuffer
            .length,
        ).toEqual(0),
      );

      // should be back to 0 connections after client closes
      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.close();

      await waitFor(() => {
        expect(numberOfConnections(clientTransport)).toEqual(0);
        expect(numberOfConnections(serverTransport)).toEqual(0);
      });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('closing a transport from the server cleans up connection on the client', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      expect(numberOfConnections(clientTransport)).toEqual(0);
      expect(numberOfConnections(serverTransport)).toEqual(0);

      // start procedure
      await client.test.add.rpc({ n: 3 });
      // end procedure

      expect(numberOfConnections(clientTransport)).toEqual(1);
      expect(numberOfConnections(serverTransport)).toEqual(1);

      // should be back to 0 connections after client closes
      clientTransport.reconnectOnConnectionDrop = false;
      serverTransport.close();

      await waitFor(() => {
        expect(numberOfConnections(clientTransport)).toEqual(0);
        expect(numberOfConnections(serverTransport)).toEqual(0);
      });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('rpc', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const serverListeners =
        serverTransport.eventDispatcher.numberOfListeners('message');
      const clientListeners =
        clientTransport.eventDispatcher.numberOfListeners('message');

      // start procedure
      const res = await client.test.add.rpc({ n: 3 });
      expect(res).toStrictEqual({ ok: true, payload: { result: 3 } });
      // end procedure

      // number of message handlers shouldn't increase after rpc
      expect(
        serverTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(serverListeners);
      expect(
        clientTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(clientListeners);

      // check number of connections
      expect(numberOfConnections(clientTransport)).toEqual(1);
      expect(numberOfConnections(serverTransport)).toEqual(1);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('stream', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const serverListeners =
        serverTransport.eventDispatcher.numberOfListeners('message');
      const clientListeners =
        clientTransport.eventDispatcher.numberOfListeners('message');

      // start procedure
      const { reqWriter, resReader } = client.test.echo.stream({});
      reqWriter.write({ msg: '1', ignore: false });
      reqWriter.write({ msg: '2', ignore: false });

      const outputIterator = getIteratorFromStream(resReader);
      const result1 = await iterNext(outputIterator);
      expect(result1).toStrictEqual({
        ok: true,
        payload: { response: '1' },
      });

      // ensure we only have one stream despite pushing multiple messages.
      reqWriter.close();
      await waitFor(() => expect(server.openStreams.size).toEqual(1));
      // ensure we no longer have any open streams since the input was closed.
      await waitFor(() => expect(server.openStreams.size).toEqual(0));

      const result2 = await iterNext(outputIterator);
      expect(result2).toStrictEqual({
        ok: true,
        payload: { response: '2' },
      });

      const result3 = await outputIterator.next();
      expect(result3.done).toBe(true);
      // end procedure

      // number of message handlers shouldn't increase after stream ends
      expect(
        serverTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(serverListeners);
      expect(
        clientTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(clientListeners);

      // check number of connections
      expect(numberOfConnections(clientTransport)).toEqual(1);
      expect(numberOfConnections(serverTransport)).toEqual(1);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('subscription', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        subscribable: SubscribableServiceSchema,
      };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const serverListeners =
        serverTransport.eventDispatcher.numberOfListeners('message');
      const clientListeners =
        clientTransport.eventDispatcher.numberOfListeners('message');

      // start procedure
      const abortController = new AbortController();
      const { resReader } = client.subscribable.value.subscribe(
        {},
        { signal: abortController.signal },
      );
      const outputIterator = getIteratorFromStream(resReader);
      let result = await iterNext(outputIterator);
      expect(result).toStrictEqual({
        ok: true,
        payload: { result: 0 },
      });

      const add1 = await client.subscribable.add.rpc({ n: 1 });
      expect(add1).toStrictEqual({ ok: true, payload: { result: 1 } });
      result = await iterNext(outputIterator);
      expect(result).toStrictEqual({
        ok: true,
        payload: { result: 1 },
      });

      abortController.abort();
      // end procedure

      // number of message handlers shouldn't increase after subscription ends
      await waitFor(() => {
        expect(
          serverTransport.eventDispatcher.numberOfListeners('message'),
        ).toEqual(serverListeners);
        expect(
          clientTransport.eventDispatcher.numberOfListeners('message'),
        ).toEqual(clientListeners);
      });

      // check number of connections
      expect(numberOfConnections(clientTransport)).toEqual(1);
      expect(numberOfConnections(serverTransport)).toEqual(1);

      // no observers should remain subscribed to the observable
      await waitFor(() =>
        expect(server.services.subscribable.state.count.listenerCount).toEqual(
          0,
        ),
      );

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('upload', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { uploadable: UploadableServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const serverListeners =
        serverTransport.eventDispatcher.numberOfListeners('message');
      const clientListeners =
        clientTransport.eventDispatcher.numberOfListeners('message');

      // start procedure
      const { reqWriter, finalize } = client.uploadable.addMultiple.upload({});
      reqWriter.write({ n: 1 });
      reqWriter.write({ n: 2 });
      reqWriter.close();

      const result = await finalize();
      expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });
      // end procedure

      // number of message handlers shouldn't increase after upload ends
      expect(
        serverTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(serverListeners);
      expect(
        clientTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(clientListeners);

      // check number of connections
      expect(numberOfConnections(clientTransport)).toEqual(1);
      expect(numberOfConnections(serverTransport)).toEqual(1);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test("shouldn't send messages across stale sessions", async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // start a stream
      const { reqWriter, resReader } = client.test.echo.stream({});
      reqWriter.write({ msg: '1', ignore: false });

      const outputIterator = getIteratorFromStream(resReader);
      const result1 = await iterNext(outputIterator);
      expect(result1).toStrictEqual({ ok: true, payload: { response: '1' } });

      // wait for session to disconnect
      clientTransport.reconnectOnConnectionDrop = false;
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));
      await advanceFakeTimersBySessionGrace();

      // reconnect
      clientTransport.reconnectOnConnectionDrop = true;
      clientTransport.connect(serverTransport.clientId);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));

      // push on the old stream and make sure its not sent

      expect(() => reqWriter.write({ msg: '2', ignore: false })).toThrow();
      const result2 = await iterNext(outputIterator);
      expect(result2).toMatchObject({ ok: false });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });
  },
);

describe('handler registered cleanups', async () => {
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

  test.each([
    { procedureType: 'rpc' },
    { procedureType: 'subscription' },
    { procedureType: 'stream' },
    { procedureType: 'upload' },
  ] as const)('$procedureType', async ({ procedureType }) => {
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    const handler = vi.fn<[ProcedureHandlerContext<object>]>();
    const serverId = 'SERVER';
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
            handler(ctx);

            return new Promise(() => {
              // never resolves
            });
          },
        }),
      }),
    };

    createServer(serverTransport, services);
    clientTransport.connect(serverId);

    addPostTestCleanup(async () => {
      await cleanupTransports([clientTransport, serverTransport]);
    });

    clientTransport.send(serverId, {
      streamId: nanoid(),
      serviceName,
      procedureName,
      payload: {},
      controlFlags: ControlFlags.StreamOpenBit,
    });

    await waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    const [ctx] = handler.mock.calls[0];

    const callOrder: Array<string> = [];
    const neverResolvesCleanup = vi.fn().mockImplementation(() => {
      callOrder.push('neverResolvesCleanup');
      return new Promise(() => {
        //
      });
    });
    ctx.onRequestFinished(neverResolvesCleanup);
    expect(neverResolvesCleanup).not.toHaveBeenCalled();

    const throwsErrorCleanup = vi.fn().mockImplementation(() => {
      callOrder.push('throwsErrorCleanup');
      throw new Error('wat');
    });
    ctx.onRequestFinished(throwsErrorCleanup);
    expect(throwsErrorCleanup).not.toHaveBeenCalled();

    const normalCleanup = vi.fn().mockImplementation(() => {
      callOrder.push('normalCleanup');
    });
    ctx.onRequestFinished(normalCleanup);
    expect(normalCleanup).not.toHaveBeenCalled();

    ctx.abortController.abort();
    expect(neverResolvesCleanup).toHaveBeenCalledOnce();
    expect(throwsErrorCleanup).toHaveBeenCalledOnce();
    expect(normalCleanup).toHaveBeenCalledOnce();
    expect(callOrder).toStrictEqual([
      'neverResolvesCleanup',
      'throwsErrorCleanup',
      'normalCleanup',
    ]);

    const registeredAfterClose = vi.fn();
    ctx.onRequestFinished(registeredAfterClose);
    expect(registeredAfterClose).toHaveBeenCalledOnce();

    const registeredAfterCloseThrows = vi.fn().mockImplementation(() => {
      throw new Error('wat');
    });
    ctx.onRequestFinished(registeredAfterCloseThrows);
    expect(registeredAfterCloseThrows).toHaveBeenCalledOnce();
  });
});
