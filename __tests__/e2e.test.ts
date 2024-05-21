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
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import {
  BinaryFileServiceSchema,
  DIV_BY_ZERO,
  FallibleServiceSchema,
  STREAM_ERROR,
  SubscribableServiceSchema,
  TestServiceSchema,
  UploadableServiceSchema,
  OrderingServiceSchema,
  NonObjectSchemas,
  SchemaWithDisposableState,
} from './fixtures/services';
import { Ok, UNCAUGHT_ERROR } from '../router/result';
import {
  advanceFakeTimersBySessionGrace,
  testFinishesCleanly,
  waitFor,
} from './fixtures/cleanup';
import { testMatrix } from './fixtures/matrix';
import { Type } from '@sinclair/typebox';
import { Procedure, ServiceSchema } from '../router';

describe.each(testMatrix())(
  'client <-> server integration test ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };
    const { getClientTransport, getServerTransport, cleanup } =
      await transport.setup({ client: opts, server: opts });
    afterAll(cleanup);

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
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
      const result = await client.test.add.rpc({ n: 3 });
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 3 });
    });

    test('fallible rpc', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        fallible: FallibleServiceSchema,
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

      // test
      const result = await client.fallible.divide.rpc({ a: 10, b: 2 });
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 5 });
      const result2 = await client.fallible.divide.rpc({ a: 10, b: 0 });
      assert(!result2.ok);
      expect(result2.payload).toStrictEqual({
        code: DIV_BY_ZERO,
        message: 'Cannot divide by zero',
        extras: {
          test: 'abc',
        },
      });
    });

    test('rpc with binary (uint8array)', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        bin: BinaryFileServiceSchema,
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

      // test
      const result = await client.bin.getFile.rpc({ file: 'test.py' });
      assert(result.ok);
      assert(result.payload.contents instanceof Uint8Array);
      expect(new TextDecoder().decode(result.payload.contents)).toStrictEqual(
        'contents for file test.py',
      );
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
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
      const [inputWriter, outputReader, close] =
        await client.test.echo.stream();
      const outputIterator = getIteratorFromStream(outputReader);

      inputWriter.write({ msg: 'abc', ignore: false });
      inputWriter.write({ msg: 'def', ignore: true });
      inputWriter.write({ msg: 'ghi', ignore: false });
      inputWriter.write({ msg: 'end', ignore: false, end: true });
      inputWriter.close();

      const result1 = await iterNext(outputIterator);
      assert(result1.ok);
      expect(result1.payload).toStrictEqual({ response: 'abc' });

      const result2 = await iterNext(outputIterator);
      assert(result2.ok);
      expect(result2.payload).toStrictEqual({ response: 'ghi' });

      const result3 = await iterNext(outputIterator);
      assert(result3.ok);
      expect(result3.payload).toStrictEqual({ response: 'end' });

      // after the server stream is ended, the client stream should be ended too
      const result4 = await outputIterator.next();
      assert(result4.done);
      close();
    });

    test('stream with init message', async () => {
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

      // test
      const [inputWriter, outputReader, close] =
        await client.test.echoWithPrefix.stream({
          prefix: 'test',
        });
      const outputIterator = getIteratorFromStream(outputReader);
      inputWriter.write({ msg: 'abc', ignore: false });
      inputWriter.write({ msg: 'def', ignore: true });
      inputWriter.write({ msg: 'ghi', ignore: false });
      inputWriter.close();

      const result1 = await iterNext(outputIterator);
      assert(result1.ok);
      expect(result1.payload).toStrictEqual({ response: 'test abc' });

      const result2 = await iterNext(outputIterator);
      assert(result2.ok);
      expect(result2.payload).toStrictEqual({ response: 'test ghi' });

      close();
    });

    test('fallible stream', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        fallible: FallibleServiceSchema,
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

      // test
      const [inputWriter, outputReader, close] =
        await client.fallible.echo.stream();
      const outputIterator = getIteratorFromStream(outputReader);
      inputWriter.write({ msg: 'abc', throwResult: false, throwError: false });
      const result1 = await iterNext(outputIterator);
      assert(result1.ok);
      expect(result1.payload).toStrictEqual({ response: 'abc' });

      inputWriter.write({ msg: 'def', throwResult: true, throwError: false });
      const result2 = await iterNext(outputIterator);
      assert(!result2.ok);
      expect(result2.payload.code).toStrictEqual(STREAM_ERROR);

      inputWriter.write({ msg: 'ghi', throwResult: false, throwError: true });
      const result3 = await iterNext(outputIterator);
      assert(!result3.ok);
      expect(result3.payload).toStrictEqual({
        code: UNCAUGHT_ERROR,
        message: 'some message',
      });

      close();
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
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
      const [outputReader, close] = await client.subscribable.value.subscribe(
        {},
      );
      const outputIterator = getIteratorFromStream(outputReader);
      let result = await iterNext(outputIterator);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 0 });

      const add1 = await client.subscribable.add.rpc({ n: 1 });
      assert(add1.ok);

      result = await iterNext(outputIterator);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 1 });

      const add2 = await client.subscribable.add.rpc({ n: 3 });
      assert(add2.ok);

      result = await iterNext(outputIterator);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 4 });

      close();
    });

    test('upload', async () => {
      // setup
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

      // test
      const [inputWriter, addResult] =
        await client.uploadable.addMultiple.upload();
      inputWriter.write({ n: 1 });
      inputWriter.write({ n: 2 });
      inputWriter.close();
      const result = await addResult;
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 3 });
    });

    test('upload with init message', async () => {
      // setup
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

      // test
      const [inputWriter, addResult] =
        await client.uploadable.addMultipleWithPrefix.upload({
          prefix: 'test',
        });
      inputWriter.write({ n: 1 });
      inputWriter.write({ n: 2 });
      inputWriter.close();
      const result = await addResult;
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 'test 3' });
    });

    test('message order is preserved in the face of disconnects', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        test: OrderingServiceSchema,
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

      // test
      const expected: Array<number> = [];
      const promises: Array<Promise<unknown>> = [];
      for (let i = 0; i < 50; i++) {
        expected.push(i);

        // randomly disconnect at some point
        if (i == 10) {
          clientTransport.connections.forEach((conn) => conn.close());
        }

        // again B)
        if (i == 42) {
          clientTransport.connections.forEach((conn) => conn.close());
        }

        promises.push(
          client.test.add.rpc({
            n: i,
          }),
        );
      }

      await Promise.all(promises);
      const res = await client.test.getAll.rpc({});
      assert(res.ok);
      expect(res.payload.msgs).toStrictEqual(expected);
    });

    const CONCURRENCY = 10;
    test('concurrent rpcs', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        test: OrderingServiceSchema,
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

      // test
      const promises = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        promises.push(client.test.add.rpc({ n: i }));
      }

      for (let i = 0; i < CONCURRENCY; i++) {
        const result = await promises[i];
        assert(result.ok);
        expect(result.payload).toStrictEqual({ n: i });
      }
    });

    test('concurrent streams', async () => {
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

      // test
      const openStreams = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        const streamHandle = await client.test.echo.stream();
        const inputWriter = streamHandle[0];
        inputWriter.write({ msg: `${i}-1`, ignore: false });
        inputWriter.write({ msg: `${i}-2`, ignore: false });
        openStreams.push(streamHandle);
      }

      for (let i = 0; i < CONCURRENCY; i++) {
        const outputReader = openStreams[i][1];
        const outputIterator = getIteratorFromStream(outputReader);
        const result1 = await iterNext(outputIterator);
        assert(result1.ok);
        expect(result1.payload).toStrictEqual({ response: `${i}-1` });

        const result2 = await iterNext(outputIterator);
        assert(result2.ok);
        expect(result2.payload).toStrictEqual({ response: `${i}-2` });
      }

      // cleanup
      for (let i = 0; i < CONCURRENCY; i++) {
        const [_input, _output, close] = openStreams[i];
        close();
      }
    });

    test('eagerlyConnect should actually eagerly connect', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      createClient<typeof services>(clientTransport, serverTransport.clientId, {
        eagerlyConnect: true,
      });

      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
      await waitFor(() => expect(serverTransport.connections.size).toEqual(1));
      await waitFor(() => expect(clientTransport.connections.size).toEqual(1));
    });

    test('client reconnects even after session grace', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
        { connectOnInvoke: true },
      );
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      await client.test.add.rpc({ n: 3 });
      await waitFor(() => expect(serverTransport.connections.size).toEqual(1));
      await waitFor(() => expect(clientTransport.connections.size).toEqual(1));

      // kill the session
      vi.useFakeTimers({ shouldAdvanceTime: true });
      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.connections.forEach((conn) => conn.close());
      await advanceFakeTimersBySessionGrace();
      clientTransport.reconnectOnConnectionDrop = true;

      // we should have no connections
      expect(serverTransport.connections.size).toEqual(0);
      expect(clientTransport.connections.size).toEqual(0);

      // client should reconnect when making another call without explicitly calling connect
      const resultPromise = client.test.add.rpc({ n: 4 });
      await waitFor(() => expect(clientTransport.connections.size).toEqual(1));
      await waitFor(() => expect(serverTransport.connections.size).toEqual(1));
      const result = await resultPromise;
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 7 });
    });

    test("client doesn't reconnect after session grace if connectOnInvoke is false", async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
        {
          connectOnInvoke: false,
        },
      );

      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      await waitFor(() => expect(serverTransport.connections.size).toEqual(1));
      await waitFor(() => expect(clientTransport.connections.size).toEqual(1));

      // kill the session
      vi.useFakeTimers({ shouldAdvanceTime: true });
      clientTransport.reconnectOnConnectionDrop = false;
      clientTransport.connections.forEach((conn) => conn.close());
      await advanceFakeTimersBySessionGrace();

      // we should have no connections
      expect(serverTransport.connections.size).toEqual(0);
      expect(clientTransport.connections.size).toEqual(0);

      // client should not reconnect when making another call
      void client.test.add.rpc({ n: 4 });
      const connectMock = vi.spyOn(clientTransport, 'connect');
      expect(connectMock).not.toHaveBeenCalled();
    });

    test('works with non-object schemas', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        nonObject: NonObjectSchemas,
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

      // test
      const result = await client.nonObject.add.rpc(3);
      assert(result.ok);
      expect(result.payload).toStrictEqual(4);

      const weirdRecursivePayload = {
        n: 1,
        next: { n: 2, next: { n: 3 } },
      };
      const result2 = await client.nonObject.echoRecursive.rpc(
        weirdRecursivePayload,
      );
      assert(result2.ok);
      expect(result2.payload).toStrictEqual(weirdRecursivePayload);
    });

    test('calls service dispose methods on cleanup', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const dispose = vi.fn();
      const services = {
        disposable: SchemaWithDisposableState(dispose),
      };
      const server = createServer(serverTransport, services);
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
      await server.close();
      expect(dispose).toBeCalledTimes(1);
    });
  },
);

describe.each(testMatrix())(
  'client <-> server with handshake tests ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const requestSchema = Type.Object({
      data: Type.String(),
    });

    const parsedSchema = Type.Object({
      data: Type.String(),
      extra: Type.Number(),
    });

    const { getClientTransport, getServerTransport, cleanup } =
      await transport.setup({
        client: {
          codec: codec.codec,
          handshake: {
            schema: requestSchema,
            get: () => ({ data: 'foobar' }),
          },
        },

        server: {
          codec: codec.codec,
          handshake: {
            requestSchema,
            parsedSchema,
            parse: (metadata) => {
              return {
                // @ts-expect-error we haven't extended the interface
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                data: metadata.data,
                extra: 42,
              };
            },
          },
        },
      });

    afterAll(cleanup);

    test('procedure can use metadata', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        test: ServiceSchema.define({
          getData: Procedure.rpc({
            input: Type.Object({}),
            output: Type.Object({
              data: Type.String(),
              extra: Type.Number(),
            }),
            handler: async (ctx) => {
              // we haven't extended the interface, so we need to suppress the error
              // with a cast
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return Ok({ ...ctx.session.metadata } as any);
            },
          }),
        }),
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

      // test
      const result = await client.test.getData.rpc({});
      assert(result.ok);
      expect(result.payload).toStrictEqual({ data: 'foobar', extra: 42 });
    });
  },
);
