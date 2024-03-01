import {
  afterAll,
  assert,
  describe,
  expect,
  onTestFinished,
  test,
} from 'vitest';
import { iterNext } from '../util/testHelpers';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import {
  BinaryFileServiceConstructor,
  DIV_BY_ZERO,
  FallibleServiceConstructor,
  OrderingServiceConstructor,
  STREAM_ERROR,
  SubscribableServiceConstructor,
  UploadableServiceConstructor,
  TestServiceConstructor,
} from './fixtures/services';
import { UNCAUGHT_ERROR } from '../router/result';
import { testFinishesCleanly } from './fixtures/cleanup';
import { buildServiceDefs } from '../router/defs';
import { testMatrix } from './fixtures/matrix';
import { bindLogger, setLevel, unbindLogger } from '../logging';

describe.each(testMatrix())(
  'client <-> server integration test ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };
    const { getClientTransport, getServerTransport, cleanup } =
      await transport.setup(opts);
    afterAll(cleanup);

    test('rpc', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
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
      const serviceDefs = buildServiceDefs([FallibleServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
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
      const serviceDefs = buildServiceDefs([BinaryFileServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
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
      const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
      const [input, output, close] = await client.test.echo.stream();
      input.push({ msg: 'abc', ignore: false });
      input.push({ msg: 'def', ignore: true });
      input.push({ msg: 'ghi', ignore: false });
      input.push({ msg: 'end', ignore: false, end: true });
      input.end();

      const result1 = await iterNext(output);
      assert(result1.ok);
      expect(result1.payload).toStrictEqual({ response: 'abc' });

      const result2 = await iterNext(output);
      assert(result2.ok);
      expect(result2.payload).toStrictEqual({ response: 'ghi' });

      const result3 = await iterNext(output);
      assert(result3.ok);
      expect(result3.payload).toStrictEqual({ response: 'end' });

      // after the server stream is ended, the client stream should be ended too
      const result4 = await output.next();
      assert(result4.done);
      close();
    });

    test('stream with init message', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
      const [input, output, close] = await client.test.echoWithPrefix.stream({
        prefix: 'test',
      });
      input.push({ msg: 'abc', ignore: false });
      input.push({ msg: 'def', ignore: true });
      input.push({ msg: 'ghi', ignore: false });
      input.end();

      const result1 = await iterNext(output);
      assert(result1.ok);
      expect(result1.payload).toStrictEqual({ response: 'test abc' });

      const result2 = await iterNext(output);
      assert(result2.ok);
      expect(result2.payload).toStrictEqual({ response: 'test ghi' });

      close();
    });

    test('fallible stream', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const serviceDefs = buildServiceDefs([FallibleServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
      const [input, output, close] = await client.fallible.echo.stream();
      input.push({ msg: 'abc', throwResult: false, throwError: false });
      const result1 = await iterNext(output);
      assert(result1.ok);
      expect(result1.payload).toStrictEqual({ response: 'abc' });

      input.push({ msg: 'def', throwResult: true, throwError: false });
      const result2 = await iterNext(output);
      assert(!result2.ok);
      expect(result2.payload.code).toStrictEqual(STREAM_ERROR);

      input.push({ msg: 'ghi', throwResult: false, throwError: true });
      const result3 = await iterNext(output);
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
      const serviceDefs = buildServiceDefs([SubscribableServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
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
      expect(result.payload).toStrictEqual({ result: 1 });

      const add2 = await client.subscribable.add.rpc({ n: 3 });
      assert(add2.ok);

      result = await iterNext(subscription);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 4 });

      close();
    });

    test('upload', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const serviceDefs = buildServiceDefs([UploadableServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
      const [addStream, addResult] =
        await client.uploadable.addMultiple.upload();
      addStream.push({ n: 1 });
      addStream.push({ n: 2 });
      addStream.end();
      const result = await addResult;
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 3 });
    });

    test('upload with init message', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const serviceDefs = buildServiceDefs([UploadableServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
      const [addStream, addResult] =
        await client.uploadable.addMultipleWithPrefix.upload({
          prefix: 'test',
        });
      addStream.push({ n: 1 });
      addStream.push({ n: 2 });
      addStream.end();
      const result = await addResult;
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 'test 3' });
    });

    test('message order is preserved in the face of disconnects', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const serviceDefs = buildServiceDefs([OrderingServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // test
      const expected: Array<number> = [];
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

        await client.test.add.rpc({
          n: i,
        });
      }

      const res = await client.test.getAll.rpc({});
      assert(res.ok);
      expect(res.payload.msgs).toStrictEqual(expected);
    });

    const CONCURRENCY = 10;
    test('concurrent rpcs', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const serviceDefs = buildServiceDefs([OrderingServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      onTestFinished(async () => {
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        });
      });

      // stest
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
      const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      onTestFinished(async () => {
        bindLogger(console.log);
        setLevel('debug');
        await testFinishesCleanly({
          clientTransports: [clientTransport],
          serverTransport,
          server,
        }).finally(() => unbindLogger());
      });

      // test
      const openStreams = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        const streamHandle = await client.test.echo.stream();
        const input = streamHandle[0];
        input.push({ msg: `${i}-1`, ignore: false });
        input.push({ msg: `${i}-2`, ignore: false });
        openStreams.push(streamHandle);
      }

      for (let i = 0; i < CONCURRENCY; i++) {
        const output = openStreams[i][1];
        const result1 = await iterNext(output);
        assert(result1.ok);
        expect(result1.payload).toStrictEqual({ response: `${i}-1` });

        const result2 = await iterNext(output);
        assert(result2.ok);
        expect(result2.payload).toStrictEqual({ response: `${i}-2` });
      }

      // cleanup
      for (let i = 0; i < CONCURRENCY; i++) {
        const [_input, _output, close] = openStreams[i];
        close();
      }
    });
  },
);
