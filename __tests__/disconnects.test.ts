import {
  afterAll,
  assert,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from 'vitest';
import { getIteratorFromStream, iterNext } from '../util/testHelpers';
import {
  SubscribableServiceSchema,
  TestServiceSchema,
  UploadableServiceSchema,
} from './fixtures/services';
import { createClient, createServer } from '../router';
import {
  advanceFakeTimersBySessionGrace,
  testFinishesCleanly,
  waitFor,
} from './fixtures/cleanup';
import { Err, UNEXPECTED_DISCONNECT } from '../router/result';
import { testMatrix } from './fixtures/matrix';

describe.each(testMatrix())(
  'procedures should handle unexpected disconnects ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };
    const { getClientTransport, getServerTransport, cleanup } =
      await transport.setup({ client: opts, server: opts });
    afterAll(cleanup);

    test('rpc', async () => {
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

      // start procedure
      await client.test.add.rpc({ n: 3 });
      expect(clientTransport.connections.size).toEqual(1);
      expect(serverTransport.connections.size).toEqual(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
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
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // start procedure
      const [inputWriter, outputReader] = client.test.echo.stream({});
      const outputIterator = getIteratorFromStream(outputReader);

      inputWriter.write({ msg: 'abc', ignore: false });
      const result = await iterNext(outputIterator);
      assert(result.ok);

      expect(clientTransport.connections.size).toEqual(1);
      expect(serverTransport.connections.size).toEqual(1);

      vi.useFakeTimers({ shouldAdvanceTime: true });
      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.connections.forEach((conn) => conn.close());

      const nextResPromise = iterNext(outputIterator);
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
    });

    test('subscription', async () => {
      const client1Transport = getClientTransport('client1');
      const client2Transport = getClientTransport('client2');
      const serverTransport = getServerTransport();

      const services = {
        subscribable: SubscribableServiceSchema,
      };
      /*const server =*/ createServer(serverTransport, services);
      const client1 = createClient<typeof services>(
        client1Transport,
        serverTransport.clientId,
      );
      const client2 = createClient<typeof services>(
        client2Transport,
        serverTransport.clientId,
      );

      // Re-enable when close requests are implemented
      // onTestFinished(async () => {
      //   await testFinishesCleanly({
      //     clientTransports: [client1Transport, client2Transport],
      //     serverTransport,
      //     server,
      //   });
      // });

      // start procedure
      // client1 and client2 both subscribe
      const outputReader1 = client1.subscribable.value.subscribe({});
      const outputIterator1 = getIteratorFromStream(outputReader1);
      let result = await iterNext(outputIterator1);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 0 });

      const outputReader2 = client2.subscribable.value.subscribe({});
      const outputIterator2 = getIteratorFromStream(outputReader2);
      result = await iterNext(outputIterator2);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 0 });

      // client2 adds a value
      const add1 = await client2.subscribable.add.rpc({ n: 1 });
      assert(add1.ok);

      // both clients should receive the updated value
      result = await iterNext(outputIterator1);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 1 });
      result = await iterNext(outputIterator2);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 1 });

      // all clients are connected
      expect(client1Transport.connections.size).toEqual(1);
      expect(client2Transport.connections.size).toEqual(1);
      expect(serverTransport.connections.size).toEqual(2);

      // kill the connection for client2
      vi.useFakeTimers({ shouldAdvanceTime: true });
      client2Transport.reconnectOnConnectionDrop = false;
      client2Transport.connections.forEach((conn) => conn.close());

      // client1 who is still connected can still add values and receive updates
      const add2Promise = client1.subscribable.add.rpc({ n: 2 });
      const nextResPromise = iterNext(outputIterator2);

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
      result = await iterNext(outputIterator1);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 3 });

      // at this point, only client1 is connected
      await waitFor(() => expect(client1Transport.connections.size).toEqual(1));
      await waitFor(() => expect(client2Transport.connections.size).toEqual(0));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(1));
      // await outputReader1.requestClose()
      // await outputReader2.requestClose()
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
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // start procedure
      const [inputWriter, getAddResult] = client.uploadable.addMultiple.upload(
        {},
      );
      inputWriter.write({ n: 1 });
      inputWriter.write({ n: 2 });
      // end procedure

      // need to wait for connection to be established
      await waitFor(() => expect(clientTransport.connections.size).toEqual(1));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(1));

      vi.useFakeTimers({ shouldAdvanceTime: true });
      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.connections.forEach((conn) => conn.close());

      // after we've disconnected, hit end of grace period
      await advanceFakeTimersBySessionGrace();

      // we should get an error + expect the streams to be cleaned up
      await expect(getAddResult()).resolves.toMatchObject(
        Err({
          code: UNEXPECTED_DISCONNECT,
        }),
      );

      await waitFor(() => expect(clientTransport.connections.size).toEqual(0));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(0));
    });
  },
);
