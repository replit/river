import { assert, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  closeAllConnections,
  createPartialContext,
  isReadableDone,
  numberOfConnections,
  readNextResult,
} from '../testUtil';
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
  SchemaWithAsyncDisposableStateAndScaffold,
} from '../testUtil/fixtures/services';
import {
  advanceFakeTimersBySessionGrace,
  cleanupTransports,
  createPostTestCleanups,
  testFinishesCleanly,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import { testMatrix } from '../testUtil/fixtures/matrix';
import { Type } from '@sinclair/typebox';
import {
  Procedure,
  createServiceSchema,
  Ok,
  UNCAUGHT_ERROR_CODE,
  CANCEL_CODE,
  MaybeDisposable,
} from '../router';
import {
  createClientHandshakeOptions,
  createServerHandshakeOptions,
} from '../router/handshake';
import { TestSetupHelpers } from '../testUtil/fixtures/transports';

describe.each(testMatrix())(
  'client <-> server integration test ($transport.name transport, $codec.name codec)',
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

      // test
      const result = await client.test.add.rpc({ n: 3 });
      expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
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
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const result = await client.fallible.divide.rpc({ a: 10, b: 2 });

      expect(result).toStrictEqual({ ok: true, payload: { result: 5 } });
      const result2 = await client.fallible.divide.rpc({ a: 10, b: 0 });
      expect(result2).toStrictEqual({
        ok: false,
        payload: {
          code: DIV_BY_ZERO,
          message: 'Cannot divide by zero',
          extras: {
            test: 'abc',
          },
        },
      });
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
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
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const result = await client.bin.getFile.rpc({ file: 'test.py' });
      expect(result).toMatchObject({ ok: true });
      assert(result.ok);
      expect(result.payload.contents).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(result.payload.contents)).toStrictEqual(
        'contents for file test.py',
      );

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

      // test
      const { reqWritable, resReadable } = client.test.echo.stream({});

      reqWritable.write({ msg: 'abc', ignore: false });
      reqWritable.write({ msg: 'def', ignore: true });
      reqWritable.write({ msg: 'ghi', ignore: false });
      reqWritable.write({ msg: 'end', ignore: false });
      reqWritable.close();

      const result1 = await readNextResult(resReadable);
      expect(result1).toStrictEqual({ ok: true, payload: { response: 'abc' } });

      const result2 = await readNextResult(resReadable);
      expect(result2).toStrictEqual({ ok: true, payload: { response: 'ghi' } });

      const result3 = await readNextResult(resReadable);
      expect(result3).toStrictEqual({ ok: true, payload: { response: 'end' } });

      // after the server stream is ended, the client stream should be ended too
      expect(await isReadableDone(resReadable)).toEqual(true);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('stream empty', async () => {
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

      // test
      const { reqWritable, resReadable } = client.test.echo.stream({});
      reqWritable.close();

      expect(await isReadableDone(resReadable)).toEqual(true);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('stream idempotent close', async () => {
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

      // test
      const abortController = new AbortController();
      const { reqWritable, resReadable } = client.test.echo.stream(
        {},
        { signal: abortController.signal },
      );
      reqWritable.write({ msg: 'abc', ignore: false });
      reqWritable.close();

      expect(await readNextResult(resReadable)).toStrictEqual({
        ok: true,
        payload: { response: 'abc' },
      });
      // Wait for the server's close to be fully processed before aborting,
      // so the abort is genuinely a no-op (testing idempotent close).
      expect(await isReadableDone(resReadable)).toEqual(true);
      abortController.abort();

      // Make sure that the handlers have finished.
      await advanceFakeTimersBySessionGrace();

      // "Accidentally" close again, as a joke.
      reqWritable.close();
      abortController.abort();

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
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
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const { reqWritable, resReadable } = client.test.echoWithPrefix.stream({
        prefix: 'test',
      });

      reqWritable.write({ msg: 'abc', ignore: false });
      reqWritable.write({ msg: 'def', ignore: true });
      reqWritable.write({ msg: 'ghi', ignore: false });
      reqWritable.close();

      const result1 = await readNextResult(resReadable);
      expect(result1).toStrictEqual({
        ok: true,
        payload: { response: 'test abc' },
      });

      const result2 = await readNextResult(resReadable);
      expect(result2).toStrictEqual({
        ok: true,
        payload: { response: 'test ghi' },
      });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
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

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const { reqWritable, resReadable } = client.fallible.echo.stream({});

      reqWritable.write({
        msg: 'abc',
        throwResult: false,
        throwError: false,
      });
      const result1 = await readNextResult(resReadable);
      expect(result1).toStrictEqual({ ok: true, payload: { response: 'abc' } });

      reqWritable.write({ msg: 'def', throwResult: true, throwError: false });
      const result2 = await readNextResult(resReadable);
      expect(result2).toMatchObject({
        ok: false,
        payload: { code: STREAM_ERROR },
      });

      reqWritable.write({ msg: 'ghi', throwResult: false, throwError: true });
      const result3 = await readNextResult(resReadable);
      expect(result3).toStrictEqual({
        ok: false,
        payload: {
          code: UNCAUGHT_ERROR_CODE,
          message: 'some message',
        },
      });

      reqWritable.close();
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

      // test
      const abortController = new AbortController();
      const { resReadable } = client.subscribable.value.subscribe(
        {},
        { signal: abortController.signal },
      );

      let result = await readNextResult(resReadable);
      expect(result).toStrictEqual({ ok: true, payload: { result: 0 } });

      const add1 = await client.subscribable.add.rpc({ n: 1 });
      expect(add1).toMatchObject({ ok: true });

      result = await readNextResult(resReadable);
      expect(result).toStrictEqual({ ok: true, payload: { result: 1 } });

      const add2 = await client.subscribable.add.rpc({ n: 3 });
      expect(add2).toMatchObject({ ok: true });

      result = await readNextResult(resReadable);
      expect(result).toStrictEqual({ ok: true, payload: { result: 4 } });

      abortController.abort();
      result = await readNextResult(resReadable);
      expect(result).toStrictEqual({
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({ code: CANCEL_CODE }),
      });
      expect(await isReadableDone(resReadable)).toEqual(true);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('subscription idempotent close', async () => {
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

      // test
      const abortController = new AbortController();
      const { resReadable } = client.subscribable.value.subscribe(
        {},
        { signal: abortController.signal },
      );
      const result1 = await readNextResult(resReadable);
      expect(result1).toStrictEqual({ ok: true, payload: { result: 0 } });
      abortController.abort();

      // Make sure that the handlers have finished.
      await advanceFakeTimersBySessionGrace();

      const result2 = await readNextResult(resReadable);
      expect(result2).toStrictEqual({
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({ code: CANCEL_CODE }),
      });

      expect(await isReadableDone(resReadable)).toEqual(true);

      // "Accidentally" call abort() again, as a joke.
      abortController.abort();

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

      // test
      const { reqWritable, finalize } = client.uploadable.addMultiple.upload(
        {},
      );
      reqWritable.write({ n: 1 });
      reqWritable.write({ n: 2 });

      const result = await finalize();
      expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('upload empty', async () => {
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
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const { reqWritable, finalize } = client.uploadable.addMultiple.upload(
        {},
      );
      reqWritable.close();
      const result = await finalize();
      expect(result).toStrictEqual({ ok: true, payload: { result: 0 } });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('upload server cancel', async () => {
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

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const { reqWritable, finalize } = client.uploadable.cancellableAdd.upload(
        {},
      );
      reqWritable.write({ n: 9 });
      reqWritable.write({ n: 1 });

      const result = await finalize();
      expect(result).toStrictEqual({
        ok: false,
        payload: { code: CANCEL_CODE, message: "can't add more than 10" },
      });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
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
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const { reqWritable, finalize } =
        client.uploadable.addMultipleWithPrefix.upload({
          prefix: 'test',
        });
      reqWritable.write({ n: 1 });
      reqWritable.write({ n: 2 });
      reqWritable.close();

      const result = await finalize();
      expect(result).toStrictEqual({ ok: true, payload: { result: 'test 3' } });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
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
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const expected: Array<number> = [];
      const promises: Array<Promise<unknown>> = [];
      for (let i = 0; i < 50; i++) {
        expected.push(i);

        // randomly disconnect at some point
        if (i == 10) {
          closeAllConnections(clientTransport);
        }

        // again B)
        if (i == 42) {
          closeAllConnections(clientTransport);
        }

        promises.push(
          client.test.add.rpc({
            n: i,
          }),
        );
      }

      await Promise.all(promises);
      const res = await client.test.getAll.rpc({});
      expect(res).toMatchObject({ ok: true, payload: { msgs: expected } });
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
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
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const promises = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        promises.push(client.test.add.rpc({ n: i }));
      }

      for (let i = 0; i < CONCURRENCY; i++) {
        const result = await promises[i];
        expect(result).toStrictEqual({ ok: true, payload: { n: i } });
      }

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
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
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const openStreams = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        const streamHandle = client.test.echo.stream({});
        const { reqWritable } = streamHandle;
        reqWritable.write({ msg: `${i}-1`, ignore: false });
        reqWritable.write({ msg: `${i}-2`, ignore: false });
        openStreams.push(streamHandle);
      }

      for (let i = 0; i < CONCURRENCY; i++) {
        const { resReadable } = openStreams[i];

        const result1 = await readNextResult(resReadable);
        expect(result1).toStrictEqual({
          ok: true,
          payload: { response: `${i}-1` },
        });

        const result2 = await readNextResult(resReadable);
        expect(result2).toStrictEqual({
          ok: true,
          payload: { response: `${i}-2` },
        });
      }

      // cleanup
      for (let i = 0; i < CONCURRENCY; i++) {
        const { reqWritable } = openStreams[i];
        reqWritable.close();
      }

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
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

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
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
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await client.test.add.rpc({ n: 3 });
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));

      // kill the session
      clientTransport.reconnectOnConnectionDrop = false;
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      await advanceFakeTimersBySessionGrace();
      clientTransport.reconnectOnConnectionDrop = true;

      // we should have no connections
      await waitFor(() => {
        expect(numberOfConnections(serverTransport)).toEqual(0);
        expect(numberOfConnections(clientTransport)).toEqual(0);
      });

      // client should reconnect when making another call without explicitly calling connect
      const resultPromise = client.test.add.rpc({ n: 4 });
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      const result = await resultPromise;
      expect(result).toStrictEqual({ ok: true, payload: { result: 7 } });
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
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

      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));

      // kill the session
      clientTransport.reconnectOnConnectionDrop = false;
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));

      await advanceFakeTimersBySessionGrace();

      // we should have no connections
      expect(numberOfConnections(serverTransport)).toEqual(0);
      expect(numberOfConnections(clientTransport)).toEqual(0);

      // client should not reconnect when making another call
      const resultPromise = client.test.add.rpc({ n: 4 });
      const connectMock = vi.spyOn(clientTransport, 'connect');
      expect(connectMock).not.toHaveBeenCalled();

      // connect and ensure that we still get the result
      clientTransport.connect(serverTransport.clientId);
      const result = await resultPromise;
      expect(result).toStrictEqual({ ok: true, payload: { result: 4 } });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('calls service dispose methods on cleanup', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const dispose = vi.fn();
      const asyncDispose = vi.fn();
      const services = {
        disposable: SchemaWithDisposableState(dispose),
        asyncDisposable:
          SchemaWithAsyncDisposableStateAndScaffold(asyncDispose),
      };

      const server = createServer(serverTransport, services);
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      await server.close();
      expect(dispose).toBeCalledTimes(1);
      expect(asyncDispose).toBeCalledTimes(1);
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('calls asyncDispose on extendedContext if it is disposable', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const asyncDispose = vi.fn();
      const services = { test: TestServiceSchema };

      const server = createServer(serverTransport, services, {
        extendedContext: {
          [Symbol.asyncDispose]: asyncDispose,
        },
      });
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      await server.close();
      expect(asyncDispose).toBeCalledTimes(1);
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('calls asyncDispose on individual context values if context itself is not disposable', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const dbDispose = vi.fn();
      const cacheDispose = vi.fn();
      const services = { test: TestServiceSchema };

      const server = createServer(serverTransport, services, {
        extendedContext: {
          db: { [Symbol.asyncDispose]: dbDispose },
          cache: { [Symbol.dispose]: cacheDispose },
        },
      });
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      await server.close();
      expect(dbDispose).toBeCalledTimes(1);
      expect(cacheDispose).toBeCalledTimes(1);
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('context disposal errors propagate to the consumer', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };

      const server = createServer(serverTransport, services, {
        extendedContext: {
          [Symbol.asyncDispose]: async () => {
            throw new Error('db connection failed to close');
          },
        },
      });
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test -- error handling is up to the consumer
      await expect(server.close()).rejects.toThrow(
        'db connection failed to close',
      );
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('createPartialContext throws on unmocked property access', async () => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
      type TestContext = {
        db: { query: (sql: string) => string };
        cache: { get: (key: string) => string };
      };

      const ctx = createPartialContext<TestContext>({
        db: { query: (sql) => `result: ${sql}` },
      });

      // provided properties work
      expect(ctx.db.query('SELECT 1')).toBe('result: SELECT 1');

      // unmocked properties throw
      expect(() => ctx.cache).toThrow(
        'cache is not mocked in the test context',
      );
    });

    test('createPartialContext works as extendedContext with server dispose', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const dbDispose = vi.fn();

      // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
      type TestContext = {
        db: { [Symbol.asyncDispose]: () => Promise<void> };
        cache: { get: (key: string) => string };
      };

      const ctx = createPartialContext<TestContext>({
        db: { [Symbol.asyncDispose]: dbDispose },
      });

      const ServiceSchema = createServiceSchema<TestContext>();
      const services = {
        test: ServiceSchema.define({
          ping: Procedure.rpc({
            requestInit: Type.Object({}),
            responseData: Type.Object({}),
            async handler() {
              return Ok({});
            },
          }),
        }),
      };

      const server = createServer(serverTransport, services, {
        extendedContext: ctx,
      });
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // server.close() should dispose context values without
      // throwing on unmocked properties (cache)
      await server.close();
      expect(dbDispose).toBeCalledTimes(1);
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
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
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const result = await client.nonObject.add.rpc(3);
      expect(result).toStrictEqual({ ok: true, payload: 4 });

      const weirdRecursivePayload = {
        n: 1,
        next: { n: 2, next: { n: 3 } },
      };
      const result2 = await client.nonObject.echoRecursive.rpc(
        weirdRecursivePayload,
      );
      expect(result2).toStrictEqual({
        ok: true,
        payload: weirdRecursivePayload,
      });
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('procedure can use metadata', async () => {
      // setup
      const requestSchema = Type.Object({
        data: Type.String(),
      });

      interface ParsedMetadata {
        data: string;
        extra: number;
      }

      const clientTransport = getClientTransport(
        'client',
        createClientHandshakeOptions(requestSchema, () => ({ data: 'foobar' })),
      );
      const serverTransport = getServerTransport(
        'SERVER',
        createServerHandshakeOptions(requestSchema, (metadata) => {
          return {
            data: metadata.data,
            extra: 42,
          };
        }),
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const ServiceSchema = createServiceSchema<
        MaybeDisposable,
        ParsedMetadata
      >();

      const TestServiceScaffold = ServiceSchema.scaffold({
        initializeState: () => ({}),
      });

      const services = {
        test: ServiceSchema.define({
          getData: Procedure.rpc({
            requestInit: Type.Object({}),
            responseData: Type.Object({
              data: Type.String(),
              extra: Type.Number(),
            }),
            handler: async ({ ctx }) => {
              return Ok({ ...ctx.metadata });
            },
          }),
        }),
        testScaffold: TestServiceScaffold.finalize({
          ...TestServiceScaffold.procedures({
            testrpc: Procedure.rpc({
              requestInit: Type.Object({}),
              responseData: Type.Object({
                data: Type.String(),
                extra: Type.Number(),
              }),
              handler: async ({ ctx }) => {
                return Ok({
                  ...ctx.metadata,
                });
              },
            }),
          }),
        }),
      };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );

      // test
      const result = await client.test.getData.rpc({});
      expect(result).toStrictEqual({
        ok: true,
        payload: { data: 'foobar', extra: 42 },
      });
      const result2 = await client.testScaffold.testrpc.rpc({});
      expect(result2).toStrictEqual({
        ok: true,
        payload: { data: 'foobar', extra: 42 },
      });
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });
  },
);
