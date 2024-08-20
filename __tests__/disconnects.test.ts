import { assert, beforeEach, describe, expect, test } from 'vitest';
import {
  closeAllConnections,
  isReadableDone,
  numberOfConnections,
  readNextResult,
} from '../util/testHelpers';
import {
  SubscribableServiceSchema,
  TestServiceSchema,
  UploadableServiceSchema,
} from './fixtures/services';
import {
  createClient,
  createServer,
  UNEXPECTED_DISCONNECT_CODE,
} from '../router';
import {
  advanceFakeTimersBySessionGrace,
  cleanupTransports,
  testFinishesCleanly,
  waitFor,
} from './fixtures/cleanup';
import { testMatrix } from './fixtures/matrix';
import { TestSetupHelpers } from './fixtures/transports';
import { createPostTestCleanups } from './fixtures/cleanup';

describe.each(testMatrix())(
  'procedures should handle unexpected disconnects ($transport.name transport, $codec.name codec)',
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
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // start procedure
      await client.test.add.rpc({ n: 3 });
      expect(numberOfConnections(clientTransport)).toEqual(1);
      expect(numberOfConnections(serverTransport)).toEqual(1);

      clientTransport.reconnectOnConnectionDrop = false;
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      const procPromise = client.test.add.rpc({ n: 4 });
      // end procedure

      // after we've disconnected, hit end of grace period
      await advanceFakeTimersBySessionGrace();

      // we should get an error + expect the streams to be cleaned up
      await expect(procPromise).resolves.toMatchObject({
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({ code: UNEXPECTED_DISCONNECT_CODE }),
      });

      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('stream', async () => {
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

      // start procedure
      const { reqWritable, resReadable } = client.test.echo.stream({});

      reqWritable.write({ msg: 'abc', ignore: false });
      const result = await readNextResult(resReadable);
      assert(result.ok);

      expect(numberOfConnections(clientTransport)).toEqual(1);
      expect(numberOfConnections(serverTransport)).toEqual(1);

      clientTransport.reconnectOnConnectionDrop = false;
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      const nextResPromise = readNextResult(resReadable);
      // end procedure

      // after we've disconnected, hit end of grace period
      await advanceFakeTimersBySessionGrace();

      // we should get an error + expect the streams to be cleaned up
      await expect(nextResPromise).resolves.toMatchObject({
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({ code: UNEXPECTED_DISCONNECT_CODE }),
      });

      // req writable should be closed
      expect(reqWritable.isWritable()).toBe(false);

      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('subscription', async () => {
      const client1Transport = getClientTransport('client1');
      const client2Transport = getClientTransport('client2');
      const serverTransport = getServerTransport();

      const services = {
        subscribable: SubscribableServiceSchema,
      };
      const server = createServer(serverTransport, services);
      const client1 = createClient<typeof services>(
        client1Transport,
        serverTransport.clientId,
      );
      const client2 = createClient<typeof services>(
        client2Transport,
        serverTransport.clientId,
      );

      addPostTestCleanup(async () => {
        await cleanupTransports([
          client1Transport,
          client2Transport,
          serverTransport,
        ]);
      });

      // start procedure
      // client1 and client2 both subscribe
      const abortController1 = new AbortController();
      const { resReadable: resReadable1 } =
        client1.subscribable.value.subscribe(
          {},
          { signal: abortController1.signal },
        );

      let result = await readNextResult(resReadable1);
      expect(result).toStrictEqual({
        ok: true,
        payload: { result: 0 },
      });

      const { resReadable: resReadable2 } =
        client2.subscribable.value.subscribe({});
      result = await readNextResult(resReadable2);
      expect(result).toStrictEqual({
        ok: true,
        payload: { result: 0 },
      });

      // client2 adds a value
      const add1 = await client2.subscribable.add.rpc({ n: 1 });
      expect(add1).toStrictEqual({ ok: true, payload: { result: 1 } });

      // both clients should receive the updated value
      result = await readNextResult(resReadable1);
      expect(result).toStrictEqual({ ok: true, payload: { result: 1 } });
      result = await readNextResult(resReadable2);
      expect(result).toStrictEqual({ ok: true, payload: { result: 1 } });

      // all clients are connected
      expect(numberOfConnections(client1Transport)).toEqual(1);
      expect(numberOfConnections(client2Transport)).toEqual(1);
      expect(numberOfConnections(serverTransport)).toEqual(2);

      // kill the connection for client2
      client2Transport.reconnectOnConnectionDrop = false;
      closeAllConnections(client2Transport);

      // wait for connections to reflect that
      await waitFor(() => {
        expect(numberOfConnections(client1Transport)).toEqual(1);
        expect(numberOfConnections(client2Transport)).toEqual(0);
        expect(numberOfConnections(serverTransport)).toEqual(1);
      });

      // client1 who is still connected can still add values and receive updates
      const add2 = await client1.subscribable.add.rpc({ n: 2 });
      expect(add2).toStrictEqual({ ok: true, payload: { result: 3 } });
      result = await readNextResult(resReadable1);
      expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });

      // try receiving a value from client2
      const nextResPromise = readNextResult(resReadable2);

      // after we've disconnected, hit end of grace period
      // because this advances the global timer, we need to wait for client1 to reconnect
      // after missing some heartbeats
      await advanceFakeTimersBySessionGrace();

      await expect(nextResPromise).resolves.toMatchObject({
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({ code: UNEXPECTED_DISCONNECT_CODE }),
      });

      // wait for client1 to restablish connection
      // (elapsing by session grace on client2 will inadvertedly trigger a phantom disconnect
      // on client1 because mocked timers are shared, which will cause it to reconnect)
      // at this point, only client1 is connected
      await waitFor(() => {
        expect(numberOfConnections(client1Transport)).toEqual(1);
        expect(numberOfConnections(client2Transport)).toEqual(0);
        expect(numberOfConnections(serverTransport)).toEqual(1);
      });

      expect(await isReadableDone(resReadable2)).toEqual(true);
      abortController1.abort();

      await testFinishesCleanly({
        clientTransports: [client1Transport, client2Transport],
        serverTransport,
        server,
      });
    });

    test('upload', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        uploadable: UploadableServiceSchema,
      };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // start procedure
      const { reqWritable, finalize } = client.uploadable.addMultiple.upload(
        {},
      );
      reqWritable.write({ n: 1 });
      reqWritable.write({ n: 2 });
      // end procedure

      // need to wait for connection to be established
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));

      clientTransport.reconnectOnConnectionDrop = false;
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      // after we've disconnected, hit end of grace period
      await advanceFakeTimersBySessionGrace();

      // we should get an error + expect the streams to be cleaned up
      await expect(finalize()).resolves.toMatchObject({
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({ code: UNEXPECTED_DISCONNECT_CODE }),
      });

      // req writable should be closed
      expect(reqWritable.isWritable()).toBe(false);

      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });
  },
);
