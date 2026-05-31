import { assert, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  closeAllConnections,
  createPartialContext,
  isReadableDone,
  numberOfConnections,
  readNextResult,
  testingSessionOptions,
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
import { Static, Type } from 'typebox';
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
import { RehandshakeStreamId } from '../transport/message';
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

    test('defaultCallOptions provides signal when caller omits it', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { subscribable: SubscribableServiceSchema };
      const server = createServer(serverTransport, services);
      const abortController = new AbortController();
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
        { defaultCallOptions: { signal: abortController.signal } },
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // No signal passed at the call site — comes from defaultCallOptions.
      const { resReadable } = client.subscribable.value.subscribe({});
      let result = await readNextResult(resReadable);
      expect(result).toStrictEqual({ ok: true, payload: { result: 0 } });

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

    test('caller-supplied signal overrides defaultCallOptions', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { subscribable: SubscribableServiceSchema };
      const server = createServer(serverTransport, services);
      const defaultAc = new AbortController();
      const callerAc = new AbortController();
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
        { defaultCallOptions: { signal: defaultAc.signal } },
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // Caller signal is the one that should drive cancellation.
      const { resReadable } = client.subscribable.value.subscribe(
        {},
        { signal: callerAc.signal },
      );
      let result = await readNextResult(resReadable);
      expect(result).toStrictEqual({ ok: true, payload: { result: 0 } });

      // Aborting the default-options signal must NOT cancel — caller wins.
      defaultAc.abort();
      const add1 = await client.subscribable.add.rpc({ n: 1 });
      expect(add1).toMatchObject({ ok: true });
      result = await readNextResult(resReadable);
      expect(result).toStrictEqual({ ok: true, payload: { result: 1 } });

      // Aborting the caller signal cancels.
      callerAc.abort();
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

    test('function-form defaultCallOptions is resolved per call', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { subscribable: SubscribableServiceSchema };
      const server = createServer(serverTransport, services);
      let currentSignal: AbortSignal | undefined;
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
        { defaultCallOptions: () => ({ signal: currentSignal }) },
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // Each subscribe resolves the getter at call time, so each call
      // captures whatever signal is current.
      const ac1 = new AbortController();
      currentSignal = ac1.signal;
      const sub1 = client.subscribable.value.subscribe({});

      const ac2 = new AbortController();
      currentSignal = ac2.signal;
      const sub2 = client.subscribable.value.subscribe({});

      let r1 = await readNextResult(sub1.resReadable);
      let r2 = await readNextResult(sub2.resReadable);
      expect(r1).toStrictEqual({ ok: true, payload: { result: 0 } });
      expect(r2).toStrictEqual({ ok: true, payload: { result: 0 } });

      // ac1 cancels sub1 only — sub2 keeps streaming.
      ac1.abort();
      r1 = await readNextResult(sub1.resReadable);
      expect(r1).toStrictEqual({
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({ code: CANCEL_CODE }),
      });
      expect(await isReadableDone(sub1.resReadable)).toEqual(true);

      const add1 = await client.subscribable.add.rpc({ n: 1 });
      expect(add1).toMatchObject({ ok: true });
      r2 = await readNextResult(sub2.resReadable);
      expect(r2).toStrictEqual({ ok: true, payload: { result: 1 } });

      ac2.abort();
      r2 = await readNextResult(sub2.resReadable);
      expect(r2).toStrictEqual({
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({ code: CANCEL_CODE }),
      });
      expect(await isReadableDone(sub2.resReadable)).toEqual(true);

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

    test('server can refresh handshake metadata over a live connection', async () => {
      const requestSchema = Type.Object({ token: Type.String() });

      type ParsedMetadata = Static<typeof requestSchema>;

      let token = 'token-v1';
      const construct = vi.fn(() => ({ token }));
      const clientTransport = getClientTransport(
        'client',
        createClientHandshakeOptions(requestSchema, construct),
      );
      const validate = vi.fn(
        (
          metadata: ParsedMetadata,
          _prev?: ParsedMetadata,
          _from?: string,
        ): ParsedMetadata => ({ token: metadata.token }),
      );
      const serverTransport = getServerTransport(
        'SERVER',
        createServerHandshakeOptions<typeof requestSchema, ParsedMetadata>(
          requestSchema,
          validate,
        ),
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const ServiceSchema = createServiceSchema<
        MaybeDisposable,
        ParsedMetadata
      >();
      const services = {
        test: ServiceSchema.define({
          getToken: Procedure.rpc({
            requestInit: Type.Object({}),
            responseData: Type.Object({ token: Type.String() }),
            handler: async ({ ctx }) => Ok({ token: ctx.metadata.token }),
          }),
        }),
      };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );

      // establish the session with the initial token
      const before = await client.test.getToken.rpc({});
      expect(before).toStrictEqual({
        ok: true,
        payload: { token: 'token-v1' },
      });

      // ask the client to refresh; construct now hands back the new token
      token = 'token-v2';
      expect(serverTransport.requestRehandshake('client')).toBe(true);

      await waitFor(() =>
        expect(
          serverTransport.sessionHandshakeMetadata.get('client'),
        ).toStrictEqual({ token: 'token-v2' }),
      );

      // the initial handshake and the re-handshake both bind to the client id
      expect(validate.mock.calls.map((call) => call[2])).toEqual([
        'client',
        'client',
      ]);

      // subsequent calls observe the refreshed metadata
      const after = await client.test.getToken.rpc({});
      expect(after).toStrictEqual({ ok: true, payload: { token: 'token-v2' } });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('server proactively re-handshakes via expiry', async () => {
      const requestSchema = Type.Object({ token: Type.String() });

      type ParsedMetadata = Static<typeof requestSchema>;

      let token = 'token-v1';
      const construct = vi.fn(() => ({ token }));
      const clientTransport = getClientTransport(
        'client',
        createClientHandshakeOptions(requestSchema, construct),
      );
      const validate = vi.fn((metadata: ParsedMetadata) => ({
        token: metadata.token,
      }));
      const serverTransport = getServerTransport(
        'SERVER',
        createServerHandshakeOptions(
          requestSchema,
          validate,
          // expire the first token soon, so the server re-handshakes shortly
          // after connecting (one handshake window before this), then stop
          (parsed) =>
            parsed.token === 'token-v1'
              ? new Date(
                  Date.now() + testingSessionOptions.handshakeTimeoutMs + 100,
                )
              : undefined,
        ),
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const ServiceSchema = createServiceSchema<
        MaybeDisposable,
        ParsedMetadata
      >();
      const services = {
        test: ServiceSchema.define({
          getToken: Procedure.rpc({
            requestInit: Type.Object({}),
            responseData: Type.Object({ token: Type.String() }),
            handler: async ({ ctx }) => Ok({ token: ctx.metadata.token }),
          }),
        }),
      };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );

      const before = await client.test.getToken.rpc({});
      expect(before).toStrictEqual({
        ok: true,
        payload: { token: 'token-v1' },
      });

      // the scheduled refresh fires on its own; construct now returns v2
      token = 'token-v2';
      await waitFor(() =>
        expect(
          serverTransport.sessionHandshakeMetadata.get('client'),
        ).toStrictEqual({ token: 'token-v2' }),
      );

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('a rejected metadata refresh tears down the session', async () => {
      const requestSchema = Type.Object({ token: Type.String() });

      type ParsedMetadata = Static<typeof requestSchema>;

      let token = 'token-v1';
      const construct = vi.fn(() => ({ token }));
      const clientTransport = getClientTransport(
        'client',
        createClientHandshakeOptions(requestSchema, construct),
      );
      const validate = vi.fn(
        (
          metadata: ParsedMetadata,
        ): ParsedMetadata | 'REJECTED_BY_CUSTOM_HANDLER' =>
          metadata.token === 'token-v1'
            ? { token: metadata.token }
            : 'REJECTED_BY_CUSTOM_HANDLER',
      );
      const serverTransport = getServerTransport<
        typeof requestSchema,
        ParsedMetadata
      >(
        'SERVER',
        createServerHandshakeOptions<typeof requestSchema, ParsedMetadata>(
          requestSchema,
          validate,
        ),
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const ServiceSchema = createServiceSchema<
        MaybeDisposable,
        ParsedMetadata
      >();
      const services = {
        test: ServiceSchema.define({
          getToken: Procedure.rpc({
            requestInit: Type.Object({}),
            responseData: Type.Object({ token: Type.String() }),
            handler: async ({ ctx }) => Ok({ token: ctx.metadata.token }),
          }),
        }),
      };
      createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );

      await client.test.getToken.rpc({});
      expect(numberOfConnections(serverTransport)).toEqual(1);

      // the client would otherwise reconnect with the same bad token; keep it
      // offline so we can assert the teardown deterministically
      clientTransport.reconnectOnConnectionDrop = false;

      // the refreshed token is rejected, so the server tears the session down
      token = 'token-v2';
      serverTransport.requestRehandshake('client');

      await waitFor(() =>
        expect(serverTransport.sessions.has('client')).toBe(false),
      );
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));

      // let the client's now-disconnected session lapse before cleanup
      await advanceFakeTimersBySessionGrace();
    });

    test('an in-flight handler observes refreshed metadata mid-stream', async () => {
      const requestSchema = Type.Object({ token: Type.String() });

      type ParsedMetadata = Static<typeof requestSchema>;

      let token = 'token-v1';
      const construct = vi.fn(() => ({ token }));
      const clientTransport = getClientTransport(
        'client',
        createClientHandshakeOptions(requestSchema, construct),
      );
      const validate = vi.fn((metadata: ParsedMetadata) => ({
        token: metadata.token,
      }));
      const serverTransport = getServerTransport(
        'SERVER',
        createServerHandshakeOptions(requestSchema, validate),
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const ServiceSchema = createServiceSchema<
        MaybeDisposable,
        ParsedMetadata
      >();
      const services = {
        test: ServiceSchema.define({
          // echoes the current metadata token for every request it receives,
          // so a single long-lived handler can be observed across a refresh
          echoToken: Procedure.stream({
            requestInit: Type.Object({}),
            requestData: Type.Object({}),
            responseData: Type.Object({ token: Type.String() }),
            handler: async ({ ctx, reqReadable, resWritable }) => {
              for await (const msg of reqReadable) {
                if (!msg.ok) break;
                resWritable.write(Ok({ token: ctx.metadata.token }));
              }
              resWritable.close();
            },
          }),
        }),
      };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );

      const { reqWritable, resReadable } = client.test.echoToken.stream({});

      reqWritable.write({});
      expect(await readNextResult(resReadable)).toStrictEqual({
        ok: true,
        payload: { token: 'token-v1' },
      });

      // refresh while the stream handler is still running
      token = 'token-v2';
      expect(serverTransport.requestRehandshake('client')).toBe(true);
      await waitFor(() =>
        expect(
          serverTransport.sessionHandshakeMetadata.get('client'),
        ).toStrictEqual({ token: 'token-v2' }),
      );

      // the same handler now sees the refreshed token
      reqWritable.write({});
      expect(await readNextResult(resReadable)).toStrictEqual({
        ok: true,
        payload: { token: 'token-v2' },
      });

      reqWritable.close();
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('a refresh the client never answers tears the session down', async () => {
      const requestSchema = Type.Object({ token: Type.String() });

      type ParsedMetadata = Static<typeof requestSchema>;

      let failRefresh = false;
      const construct = vi.fn(() => {
        if (failRefresh) {
          // a client that refuses to hand back a fresh token
          throw new Error('client refuses to refresh');
        }

        return { token: 'token-v1' };
      });
      const clientTransport = getClientTransport(
        'client',
        createClientHandshakeOptions(requestSchema, construct),
      );
      const validate = vi.fn((metadata: ParsedMetadata) => ({
        token: metadata.token,
      }));
      const serverTransport = getServerTransport(
        'SERVER',
        createServerHandshakeOptions(requestSchema, validate),
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const ServiceSchema = createServiceSchema<
        MaybeDisposable,
        ParsedMetadata
      >();
      const services = {
        test: ServiceSchema.define({
          getToken: Procedure.rpc({
            requestInit: Type.Object({}),
            responseData: Type.Object({ token: Type.String() }),
            handler: async ({ ctx }) => Ok({ token: ctx.metadata.token }),
          }),
        }),
      };
      createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );

      await client.test.getToken.rpc({});
      expect(numberOfConnections(serverTransport)).toEqual(1);

      // the client will ignore the refresh; keep it offline so the teardown is
      // observable rather than racing a reconnect
      failRefresh = true;
      clientTransport.reconnectOnConnectionDrop = false;

      serverTransport.requestRehandshake('client');

      // with no valid response, the deadline elapses and the server tears the
      // session down rather than trusting the stale metadata indefinitely
      await vi.advanceTimersByTimeAsync(
        testingSessionOptions.handshakeTimeoutMs + 1,
      );
      await waitFor(() =>
        expect(serverTransport.sessions.has('client')).toBe(false),
      );

      await advanceFakeTimersBySessionGrace();
    });

    test('a malformed re-handshake frame tears the session down', async () => {
      const requestSchema = Type.Object({ token: Type.String() });

      type ParsedMetadata = Static<typeof requestSchema>;

      const construct = vi.fn(() => ({ token: 'token-v1' }));
      const clientTransport = getClientTransport(
        'client',
        createClientHandshakeOptions(requestSchema, construct),
      );
      const validate = vi.fn((metadata: ParsedMetadata) => ({
        token: metadata.token,
      }));
      const serverTransport = getServerTransport(
        'SERVER',
        createServerHandshakeOptions(requestSchema, validate),
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      clientTransport.connect(serverTransport.clientId);
      await waitFor(() => {
        expect(serverTransport.sessions.has('client')).toBe(true);
        expect(numberOfConnections(clientTransport)).toBe(1);
      });

      // keep the client offline so the teardown is observable, not racing a reconnect
      clientTransport.reconnectOnConnectionDrop = false;

      // a connected peer sends a garbage payload on the reserved re-handshake
      // stream; the server treats the protocol violation as a failed re-handshake
      const clientSession = clientTransport.sessions.get(
        serverTransport.clientId,
      );
      assert(clientSession);
      const send = clientTransport.getSessionBoundSendFn(
        serverTransport.clientId,
        clientSession.id,
      );
      send({
        streamId: RehandshakeStreamId,
        controlFlags: 0,
        payload: { type: 'NOT_A_REHANDSHAKE_RESPONSE' },
      });

      await waitFor(() =>
        expect(serverTransport.sessions.has('client')).toBe(false),
      );

      await advanceFakeTimersBySessionGrace();
    });

    test('validate receives the connecting client id', async () => {
      const requestSchema = Type.Object({});

      interface ParsedMetadata {
        seenFrom: string;
      }

      const construct = vi.fn(() => ({}));
      const clientTransport = getClientTransport(
        'client',
        createClientHandshakeOptions(requestSchema, construct),
      );
      const validate = vi.fn(
        (
          _metadata: Static<typeof requestSchema>,
          _prev?: ParsedMetadata,
          from?: string,
        ): ParsedMetadata => ({ seenFrom: from ?? '<none>' }),
      );
      const serverTransport = getServerTransport(
        'SERVER',
        createServerHandshakeOptions(requestSchema, validate),
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      const ServiceSchema = createServiceSchema<
        MaybeDisposable,
        ParsedMetadata
      >();
      const services = {
        test: ServiceSchema.define({
          whoami: Procedure.rpc({
            requestInit: Type.Object({}),
            responseData: Type.Object({ seenFrom: Type.String() }),
            handler: async ({ ctx }) => Ok({ seenFrom: ctx.metadata.seenFrom }),
          }),
        }),
      };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );

      const result = await client.test.whoami.rpc({});
      expect(result).toStrictEqual({
        ok: true,
        payload: { seenFrom: 'client' },
      });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });
  },
);
