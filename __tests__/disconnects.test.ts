import { assert, beforeEach, describe, expect, test } from 'vitest';
import { iterNext } from '../util/testHelpers';
import {
  SubscribableServiceSchema,
  TestServiceSchema,
  UploadableServiceSchema,
} from './fixtures/services';
import { createClient, createServer } from '../router';
import {
  advanceFakeTimersBySessionGrace,
  cleanupTransports,
  testFinishesCleanly,
  waitFor,
} from './fixtures/cleanup';
import { Err, UNEXPECTED_DISCONNECT } from '../router/result';
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
      expect(clientTransport.connections.size).toEqual(1);
      expect(serverTransport.connections.size).toEqual(1);

      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.connections.forEach((conn) => conn.close());

      const procPromise = client.test.add.rpc({ n: 4 });
      // end procedure

      // after we've disconnected, hit end of grace period
      await advanceFakeTimersBySessionGrace();

      // we should get an error + expect the streams to be cleaned up
      await expect(procPromise).resolves.toMatchObject(
        Err({
          code: UNEXPECTED_DISCONNECT,
        }),
      );

      await waitFor(() => expect(clientTransport.connections.size).toEqual(0));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(0));
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
      const [input, output] = await client.test.echo.stream();
      input.push({ msg: 'abc', ignore: false });
      const result = await iterNext(output);
      assert(result.ok);

      expect(clientTransport.connections.size).toEqual(1);
      expect(serverTransport.connections.size).toEqual(1);

      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.connections.forEach((conn) => conn.close());

      const nextResPromise = iterNext(output);
      // end procedure

      // after we've disconnected, hit end of grace period
      await advanceFakeTimersBySessionGrace();

      // we should get an error + expect the streams to be cleaned up
      await expect(nextResPromise).resolves.toMatchObject(
        Err({
          code: UNEXPECTED_DISCONNECT,
        }),
      );

      await waitFor(() => expect(clientTransport.connections.size).toEqual(0));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(0));
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
      const [subscription1, close1] =
        await client1.subscribable.value.subscribe({});
      let result = await iterNext(subscription1);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 0 });

      const [subscription2, close2] =
        await client2.subscribable.value.subscribe({});
      result = await iterNext(subscription2);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 0 });

      // client2 adds a value
      const add1 = await client2.subscribable.add.rpc({ n: 1 });
      assert(add1.ok);

      // both clients should receive the updated value
      result = await iterNext(subscription1);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 1 });
      result = await iterNext(subscription2);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 1 });

      // all clients are connected
      expect(client1Transport.connections.size).toEqual(1);
      expect(client2Transport.connections.size).toEqual(1);
      expect(serverTransport.connections.size).toEqual(2);

      // kill the connection for client2
      client2Transport.reconnectOnConnectionDrop = false;
      client2Transport.connections.forEach((conn) => conn.close());

      // client1 who is still connected can still add values and receive updates
      const add2Promise = client1.subscribable.add.rpc({ n: 2 });
      const nextResPromise = iterNext(subscription2);

      // after we've disconnected, hit end of grace period
      await advanceFakeTimersBySessionGrace();

      // we should get an error from the subscription on client2
      await expect(nextResPromise).resolves.toMatchObject(
        Err({
          code: UNEXPECTED_DISCONNECT,
        }),
      );

      // client1 who is still connected can still add values and receive updates
      assert((await add2Promise).ok);
      result = await iterNext(subscription1);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 3 });

      // at this point, only client1 is connected
      await waitFor(() => expect(client1Transport.connections.size).toEqual(1));
      await waitFor(() => expect(client2Transport.connections.size).toEqual(0));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(1));

      // cleanup client1 (client2 is already disconnected)
      close1();
      close2();
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
      const [addStream, addResult] =
        await client.uploadable.addMultiple.upload();
      addStream.push({ n: 1 });
      addStream.push({ n: 2 });
      // end procedure

      // need to wait for connection to be established
      await waitFor(() => expect(clientTransport.connections.size).toEqual(1));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(1));

      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.connections.forEach((conn) => conn.close());

      // after we've disconnected, hit end of grace period
      await advanceFakeTimersBySessionGrace();

      // we should get an error + expect the streams to be cleaned up
      await expect(addResult).resolves.toMatchObject(
        Err({
          code: UNEXPECTED_DISCONNECT,
        }),
      );

      await waitFor(() => expect(clientTransport.connections.size).toEqual(0));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(0));
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });
  },
);
