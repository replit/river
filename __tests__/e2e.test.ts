import { afterAll, assert, describe, expect, test } from 'vitest';
import {
  createLocalWebSocketClient,
  createWebSocketServer,
  createWsTransports,
  iterNext,
  onServerReady,
} from '../util/testHelpers';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import http from 'http';
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
import { codecs } from '../codec/codec.test';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import { WebSocketServerTransport } from '../transport/impls/ws/server';
import { testFinishesCleanly } from './fixtures/cleanup';

describe.each(codecs)(
  'client <-> server integration test ($name codec)',
  async ({ codec }) => {
    const httpServer = http.createServer();
    const port = await onServerReady(httpServer);
    const webSocketServer = await createWebSocketServer(httpServer);
    const getTransports = () =>
      createWsTransports(port, webSocketServer, codec);

    afterAll(() => {
      webSocketServer.close();
      httpServer.close();
    });

    test('rpc', async () => {
      const [clientTransport, serverTransport] = getTransports();
      const serviceDefs = { test: TestServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      const result = await client.test.add.rpc({ n: 3 });
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 3 });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('fallible rpc', async () => {
      const [clientTransport, serverTransport] = getTransports();
      const serviceDefs = { test: FallibleServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      const result = await client.test.divide.rpc({ a: 10, b: 2 });
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 5 });
      const result2 = await client.test.divide.rpc({ a: 10, b: 0 });
      assert(!result2.ok);
      expect(result2.payload).toStrictEqual({
        code: DIV_BY_ZERO,
        message: 'Cannot divide by zero',
        extras: {
          test: 'abc',
        },
      });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('rpc with binary (uint8array)', async () => {
      const [clientTransport, serverTransport] = getTransports();
      const serviceDefs = { test: BinaryFileServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      const result = await client.test.getFile.rpc({ file: 'test.py' });
      assert(result.ok);
      assert(result.payload.contents instanceof Uint8Array);
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
      const [clientTransport, serverTransport] = getTransports();
      const serviceDefs = { test: TestServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);

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
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('stream with init message', async () => {
      const [clientTransport, serverTransport] = getTransports();
      const serviceDefs = { test: TestServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);

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
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('fallible stream', async () => {
      const [clientTransport, serverTransport] = getTransports();
      const serviceDefs = { test: FallibleServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);

      const [input, output, close] = await client.test.echo.stream();
      input.push({ msg: 'abc', throwResult: false, throwError: false });
      const result1 = await iterNext(output);
      assert(result1 && result1.ok);
      expect(result1.payload).toStrictEqual({ response: 'abc' });

      input.push({ msg: 'def', throwResult: true, throwError: false });
      const result2 = await iterNext(output);
      assert(result2 && !result2.ok);
      expect(result2.payload.code).toStrictEqual(STREAM_ERROR);

      input.push({ msg: 'ghi', throwResult: false, throwError: true });
      const result3 = await iterNext(output);
      assert(result3 && !result3.ok);
      expect(result3.payload).toStrictEqual({
        code: UNCAUGHT_ERROR,
        message: 'some message',
      });

      close();
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('subscription', async () => {
      const options = { codec };
      const serverTransport = new WebSocketServerTransport(
        webSocketServer,
        'SERVER',
        options,
      );
      const client1Transport = new WebSocketClientTransport(
        () => createLocalWebSocketClient(port),
        'client1',
        'SERVER',
        options,
      );
      const client2Transport = new WebSocketClientTransport(
        () => createLocalWebSocketClient(port),
        'client2',
        'SERVER',
        options,
      );

      const serviceDefs = { test: SubscribableServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client1 = createClient<typeof server>(client1Transport);
      const client2 = createClient<typeof server>(client2Transport);
      const [subscription1, close1] = await client1.test.value.subscribe({});
      let result = await iterNext(subscription1);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 0 });

      const [subscription2, close2] = await client2.test.value.subscribe({});
      result = await iterNext(subscription2);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 0 });

      const add1 = await client1.test.add.rpc({ n: 1 });
      assert(add1.ok);

      result = await iterNext(subscription1);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 1 });
      result = await iterNext(subscription2);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 1 });

      const add2 = await client2.test.add.rpc({ n: 3 });
      assert(add2.ok);

      result = await iterNext(subscription1);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 4 });
      result = await iterNext(subscription2);
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 4 });

      close1();
      close2();

      await testFinishesCleanly({
        clientTransports: [client1Transport, client2Transport],
        serverTransport,
        server,
      });
    });

    test('upload', async () => {
      const [clientTransport, serverTransport] = getTransports();
      const serviceDefs = { uploadable: UploadableServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);

      const [addStream, addResult] =
        await client.uploadable.addMultiple.upload();
      addStream.push({ n: 1 });
      addStream.push({ n: 2 });
      addStream.end();
      const result = await addResult;
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 3 });
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('upload with init message', async () => {
      const [clientTransport, serverTransport] = getTransports();
      const serviceDefs = { uploadable: UploadableServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);

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
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('message order is preserved in the face of disconnects', async () => {
      const [clientTransport, serverTransport] = getTransports();
      const serviceDefs = { test: OrderingServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);

      const expected: number[] = [];
      for (let i = 0; i < 50; i++) {
        expected.push(i);

        if (i == 10) {
          clientTransport.connections.forEach((conn) => conn.ws.close());
        }

        if (i == 42) {
          clientTransport.connections.forEach((conn) => conn.ws.terminate());
        }

        await client.test.add.rpc({
          n: i,
        });
      }

      const res = await client.test.getAll.rpc({});
      assert(res.ok);
      expect(res.payload.msgs).toStrictEqual(expected);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    const CONCURRENCY = 10;
    test('concurrent rpcs', async () => {
      const [clientTransport, serverTransport] = getTransports();
      const serviceDefs = { test: OrderingServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);

      const promises = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        promises.push(client.test.add.rpc({ n: i }));
      }

      for (let i = 0; i < CONCURRENCY; i++) {
        const result = await promises[i];
        assert(result.ok);
        expect(result.payload).toStrictEqual({ n: i });
      }

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('concurrent streams', async () => {
      const [clientTransport, serverTransport] = getTransports();
      const serviceDefs = { test: TestServiceConstructor() };
      const server = createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);

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

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });
  },
);
