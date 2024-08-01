import { assert, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  closeAllConnections,
  isReadableDone,
  numberOfConnections,
  readNextResult,
} from '../util/testHelpers';
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
} from './fixtures/services';
import {
  advanceFakeTimersBySessionGrace,
  cleanupTransports,
  createPostTestCleanups,
  testFinishesCleanly,
  waitFor,
} from './fixtures/cleanup';
import { testMatrix } from './fixtures/matrix';
import { Type } from '@sinclair/typebox';
import {
  Procedure,
  ServiceSchema,
  Ok,
  UNCAUGHT_ERROR_CODE,
  ABORT_CODE,
} from '../router';
import {
  createClientHandshakeOptions,
  createServerHandshakeOptions,
} from '../router/handshake';
import { TestSetupHelpers } from './fixtures/transports';

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
      const { reqWriter, resReader } = client.test.echo.stream({});

      reqWriter.write({ msg: 'abc', ignore: false });
      reqWriter.write({ msg: 'def', ignore: true });
      reqWriter.write({ msg: 'ghi', ignore: false });
      reqWriter.write({ msg: 'end', ignore: false });
      reqWriter.close();

      const result1 = await readNextResult(resReader);
      expect(result1).toStrictEqual({ ok: true, payload: { response: 'abc' } });

      const result2 = await readNextResult(resReader);
      expect(result2).toStrictEqual({ ok: true, payload: { response: 'ghi' } });

      const result3 = await readNextResult(resReader);
      expect(result3).toStrictEqual({ ok: true, payload: { response: 'end' } });

      // after the server stream is ended, the client stream should be ended too
      expect(await isReadableDone(resReader)).toEqual(true);

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
      const { reqWriter, resReader } = client.test.echo.stream({});
      reqWriter.close();

      expect(await isReadableDone(resReader)).toEqual(true);

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
      const { reqWriter, resReader } = client.test.echo.stream(
        {},
        { signal: abortController.signal },
      );
      reqWriter.write({ msg: 'abc', ignore: false });
      reqWriter.close();

      expect(await readNextResult(resReader)).toStrictEqual({
        ok: true,
        payload: { response: 'abc' },
      });
      abortController.abort();
      expect(await isReadableDone(resReader)).toEqual(true);

      // Make sure that the handlers have finished.
      await advanceFakeTimersBySessionGrace();

      // "Accidentally" close again, as a joke.
      reqWriter.close();
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
      const { reqWriter, resReader } = client.test.echoWithPrefix.stream({
        prefix: 'test',
      });

      reqWriter.write({ msg: 'abc', ignore: false });
      reqWriter.write({ msg: 'def', ignore: true });
      reqWriter.write({ msg: 'ghi', ignore: false });
      reqWriter.close();

      const result1 = await readNextResult(resReader);
      expect(result1).toStrictEqual({
        ok: true,
        payload: { response: 'test abc' },
      });

      const result2 = await readNextResult(resReader);
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
      const { reqWriter, resReader } = client.fallible.echo.stream({});

      reqWriter.write({
        msg: 'abc',
        throwResult: false,
        throwError: false,
      });
      const result1 = await readNextResult(resReader);
      expect(result1).toStrictEqual({ ok: true, payload: { response: 'abc' } });

      reqWriter.write({ msg: 'def', throwResult: true, throwError: false });
      const result2 = await readNextResult(resReader);
      expect(result2).toMatchObject({
        ok: false,
        payload: { code: STREAM_ERROR },
      });

      reqWriter.write({ msg: 'ghi', throwResult: false, throwError: true });
      const result3 = await readNextResult(resReader);
      expect(result3).toStrictEqual({
        ok: false,
        payload: {
          code: UNCAUGHT_ERROR_CODE,
          message: 'some message',
        },
      });

      reqWriter.close();
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
      const { resReader } = client.subscribable.value.subscribe(
        {},
        { signal: abortController.signal },
      );

      let result = await readNextResult(resReader);
      expect(result).toStrictEqual({ ok: true, payload: { result: 0 } });

      const add1 = await client.subscribable.add.rpc({ n: 1 });
      expect(add1).toMatchObject({ ok: true });

      result = await readNextResult(resReader);
      expect(result).toStrictEqual({ ok: true, payload: { result: 1 } });

      const add2 = await client.subscribable.add.rpc({ n: 3 });
      expect(add2).toMatchObject({ ok: true });

      result = await readNextResult(resReader);
      expect(result).toStrictEqual({ ok: true, payload: { result: 4 } });

      abortController.abort();
      result = await readNextResult(resReader);
      expect(result).toStrictEqual({
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({ code: ABORT_CODE }),
      });
      expect(await isReadableDone(resReader)).toEqual(true);

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
      const { resReader } = client.subscribable.value.subscribe(
        {},
        { signal: abortController.signal },
      );
      const result1 = await readNextResult(resReader);
      expect(result1).toStrictEqual({ ok: true, payload: { result: 0 } });
      abortController.abort();

      // Make sure that the handlers have finished.
      await advanceFakeTimersBySessionGrace();

      const result2 = await readNextResult(resReader);
      expect(result2).toStrictEqual({
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({ code: ABORT_CODE }),
      });

      expect(await isReadableDone(resReader)).toEqual(true);

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
      const { reqWriter, finalize } = client.uploadable.addMultiple.upload({});
      reqWriter.write({ n: 1 });
      reqWriter.write({ n: 2 });

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
      const { reqWriter, finalize } = client.uploadable.addMultiple.upload({});
      reqWriter.close();
      const result = await finalize();
      expect(result).toStrictEqual({ ok: true, payload: { result: 0 } });

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
      const { reqWriter, finalize } =
        client.uploadable.addMultipleWithPrefix.upload({
          prefix: 'test',
        });
      reqWriter.write({ n: 1 });
      reqWriter.write({ n: 2 });
      reqWriter.close();

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
        const { reqWriter } = streamHandle;
        reqWriter.write({ msg: `${i}-1`, ignore: false });
        reqWriter.write({ msg: `${i}-2`, ignore: false });
        openStreams.push(streamHandle);
      }

      for (let i = 0; i < CONCURRENCY; i++) {
        const { resReader } = openStreams[i];

        const result1 = await readNextResult(resReader);
        expect(result1).toStrictEqual({
          ok: true,
          payload: { response: `${i}-1` },
        });

        const result2 = await readNextResult(resReader);
        expect(result2).toStrictEqual({
          ok: true,
          payload: { response: `${i}-2` },
        });
      }

      // cleanup
      for (let i = 0; i < CONCURRENCY; i++) {
        const { reqWriter } = openStreams[i];
        reqWriter.close();
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
      const clientTransport = getClientTransport(
        'client',
        createClientHandshakeOptions(requestSchema, () => ({ data: 'foobar' })),
      );
      const serverTransport = getServerTransport(
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

      const services = {
        test: ServiceSchema.define({
          getData: Procedure.rpc({
            requestInit: Type.Object({}),
            responseData: Type.Object({
              data: Type.String(),
              extra: Type.Number(),
            }),
            handler: async ({ ctx }) => {
              // we haven't extended the interface
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return Ok({ ...ctx.metadata } as { data: string; extra: number });
            },
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
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });
  },
);
