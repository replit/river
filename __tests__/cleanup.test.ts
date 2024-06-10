import { afterAll, assert, describe, expect, test, vi } from 'vitest';
import { iterNext } from '../util/testHelpers';
import {
  SubscribableServiceSchema,
  TestServiceSchema,
  UploadableServiceSchema,
} from './fixtures/services';
import { createClient, createServer } from '../router';
import {
  advanceFakeTimersBySessionGrace,
  ensureTransportBuffersAreEventuallyEmpty,
  testFinishesCleanly,
  waitFor,
  waitForTransportToFinish,
} from './fixtures/cleanup';
import { testMatrix } from './fixtures/matrix';

describe.each(testMatrix())(
  'procedures should clean up after themselves ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };
    const { getClientTransport, getServerTransport, cleanup } =
      await transport.setup({ client: opts, server: opts });
    afterAll(cleanup);

    test('closing a transport from the client cleans up connection on the server', async ({
      onTestFinished,
    }) => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      expect(clientTransport.connections.size).toEqual(0);
      expect(serverTransport.connections.size).toEqual(0);

      // start procedure
      await client.test.add.rpc({ n: 3 });
      // end procedure

      expect(clientTransport.connections.size).toEqual(1);
      expect(serverTransport.connections.size).toEqual(1);

      // should be back to 0 connections after client closes
      vi.useFakeTimers({ shouldAdvanceTime: true });
      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.close();

      await waitForTransportToFinish(clientTransport);
      await waitForTransportToFinish(serverTransport);
      await advanceFakeTimersBySessionGrace();
      await ensureTransportBuffersAreEventuallyEmpty(clientTransport);
      await ensureTransportBuffersAreEventuallyEmpty(serverTransport);
    });

    test('closing a transport from the server cleans up connection on the client', async ({
      onTestFinished,
    }) => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      expect(clientTransport.connections.size).toEqual(0);
      expect(serverTransport.connections.size).toEqual(0);

      // start procedure
      await client.test.add.rpc({ n: 3 });
      // end procedure

      expect(clientTransport.connections.size).toEqual(1);
      expect(serverTransport.connections.size).toEqual(1);

      // should be back to 0 connections after client closes
      vi.useFakeTimers({ shouldAdvanceTime: true });
      clientTransport.reconnectOnConnectionDrop = false;
      serverTransport.close();

      await waitForTransportToFinish(clientTransport);
      await waitForTransportToFinish(serverTransport);
      await advanceFakeTimersBySessionGrace();
      await ensureTransportBuffersAreEventuallyEmpty(clientTransport);
      await ensureTransportBuffersAreEventuallyEmpty(serverTransport);
    });

    test('rpc', async ({ onTestFinished }) => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      const serverListeners =
        serverTransport.eventDispatcher.numberOfListeners('message');
      const clientListeners =
        clientTransport.eventDispatcher.numberOfListeners('message');

      // start procedure
      await client.test.add.rpc({ n: 3 });
      // end procedure

      // number of message handlers shouldn't increase after rpc
      expect(
        serverTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(serverListeners);
      expect(
        clientTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(clientListeners);

      // check number of connections
      expect(serverTransport.connections.size).toEqual(1);
      expect(clientTransport.connections.size).toEqual(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      await waitForTransportToFinish(clientTransport);
      await waitForTransportToFinish(serverTransport);
      await advanceFakeTimersBySessionGrace();
      await ensureTransportBuffersAreEventuallyEmpty(clientTransport);
      await ensureTransportBuffersAreEventuallyEmpty(serverTransport);
    });

    test('stream', async ({ onTestFinished }) => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      const serverListeners =
        serverTransport.eventDispatcher.numberOfListeners('message');
      const clientListeners =
        clientTransport.eventDispatcher.numberOfListeners('message');

      // start procedure
      const [input, output, close] = await client.test.echo.stream();
      input.push({ msg: '1', ignore: false, end: undefined });
      input.push({ msg: '2', ignore: false, end: true });

      const result1 = await iterNext(output);
      assert(result1.ok);
      expect(result1.payload).toStrictEqual({ response: '1' });

      // ensure we only have one stream despite pushing multiple messages.
      await waitFor(() => expect(server.streams.size).toEqual(1));
      input.end();
      // ensure we no longer have any streams since the input was closed.
      await waitFor(() => expect(server.streams.size).toEqual(0));

      const result2 = await iterNext(output);
      assert(result2.ok);
      expect(result2.payload).toStrictEqual({ response: '2' });

      const result3 = await output.next();
      assert(result3.done);

      close();
      // end procedure

      // number of message handlers shouldn't increase after stream ends
      expect(
        serverTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(serverListeners);
      expect(
        clientTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(clientListeners);

      // check number of connections
      expect(serverTransport.connections.size).toEqual(1);
      expect(clientTransport.connections.size).toEqual(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      await waitForTransportToFinish(clientTransport);
      await waitForTransportToFinish(serverTransport);
      await advanceFakeTimersBySessionGrace();
      await ensureTransportBuffersAreEventuallyEmpty(clientTransport);
      await ensureTransportBuffersAreEventuallyEmpty(serverTransport);
    });

    test('subscription', async ({ onTestFinished }) => {
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
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      const serverListeners =
        serverTransport.eventDispatcher.numberOfListeners('message');
      const clientListeners =
        clientTransport.eventDispatcher.numberOfListeners('message');

      // start procedure
      const [subscription, close] = await client.subscribable.value.subscribe(
        {},
      );
      let result = await iterNext(subscription);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 0 });
      const add1 = await client.subscribable.add.rpc({ n: 1 });
      assert(add1.ok);
      result = await iterNext(subscription);
      assert(result.ok);

      close();
      // end procedure

      // number of message handlers shouldn't increase after subscription ends
      expect(
        serverTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(serverListeners);
      expect(
        clientTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(clientListeners);

      // check number of connections
      expect(serverTransport.connections.size).toEqual(1);
      expect(clientTransport.connections.size).toEqual(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      await waitForTransportToFinish(clientTransport);
      await waitForTransportToFinish(serverTransport);
      await advanceFakeTimersBySessionGrace();
      await ensureTransportBuffersAreEventuallyEmpty(clientTransport);
      await ensureTransportBuffersAreEventuallyEmpty(serverTransport);

      // no observers should remain subscribed to the observable
      expect(server.services.subscribable.state.count.listenerCount).toEqual(0);
    });

    test('upload', async ({ onTestFinished }) => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { uploadable: UploadableServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      const serverListeners =
        serverTransport.eventDispatcher.numberOfListeners('message');
      const clientListeners =
        clientTransport.eventDispatcher.numberOfListeners('message');

      // start procedure
      const [addStream, addResult] =
        await client.uploadable.addMultiple.upload();
      addStream.push({ n: 1 });
      addStream.push({ n: 2 });
      addStream.end();

      const result = await addResult;
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 3 });
      // end procedure

      // number of message handlers shouldn't increase after upload ends
      expect(
        serverTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(serverListeners);
      expect(
        clientTransport.eventDispatcher.numberOfListeners('message'),
      ).toEqual(clientListeners);

      // check number of connections
      expect(serverTransport.connections.size).toEqual(1);
      expect(clientTransport.connections.size).toEqual(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      await waitForTransportToFinish(clientTransport);
      await waitForTransportToFinish(serverTransport);
      await advanceFakeTimersBySessionGrace();
      await ensureTransportBuffersAreEventuallyEmpty(clientTransport);
      await ensureTransportBuffersAreEventuallyEmpty(serverTransport);
    });

    test("shouldn't send messages across stale sessions", async ({
      onTestFinished,
    }) => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );

      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // start a stream
      const [input, output] = await client.test.echo.stream();
      input.push({ msg: '1', ignore: false });

      const result1 = await iterNext(output);
      assert(result1.ok);
      expect(result1.payload).toStrictEqual({ response: '1' });

      // wait for session to disconnect
      vi.useFakeTimers({ shouldAdvanceTime: true });
      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.connections.forEach((conn) => conn.close());
      await advanceFakeTimersBySessionGrace();

      expect(clientTransport.sessions.size).toEqual(0);

      // reconnect
      clientTransport.reconnectOnConnectionDrop = true;
      void clientTransport.connect(serverTransport.clientId);
      await waitFor(() => expect(clientTransport.connections.size).toEqual(1));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(1));

      // push on the old stream and make sure its not sent
      input.push({ msg: '2', ignore: false });
      const result2 = await iterNext(output);
      assert(!result2.ok);
    });
  },
);
