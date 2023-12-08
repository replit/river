import {
  afterAll,
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
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
  TestServiceConstructor,
} from './fixtures/services';
import { UNCAUGHT_ERROR } from '../router/result';
import { codecs } from '../codec/codec.test';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import { WebSocketServerTransport } from '../transport/impls/ws/server';
import {
  ensureServerIsClean,
  ensureTransportIsClean,
} from './fixtures/cleanup';

describe.each(codecs)(
  'client <-> server integration test ($name codec)',
  async ({ codec }) => {
    const httpServer = http.createServer();
    const port = await onServerReady(httpServer);
    const webSocketServer = await createWebSocketServer(httpServer);

    let clientTransport: WebSocketClientTransport;
    let serverTransport: WebSocketServerTransport;

    beforeEach(() => {
      [clientTransport, serverTransport] = createWsTransports(
        port,
        webSocketServer,
        codec,
      );
    });

    afterEach(async () => {
      await clientTransport.close();
      await serverTransport.close();
      ensureTransportIsClean(clientTransport);
      ensureTransportIsClean(serverTransport);
    });

    afterAll(() => {
      webSocketServer.close();
      httpServer.close();
    });

    test('rpc', async () => {
      const serviceDefs = { test: TestServiceConstructor() };
      const server = await createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      const result = await client.test.add.rpc({ n: 3 });
      assert(result.ok);
      expect(result.payload).toStrictEqual({ result: 3 });
      await server.close();
      ensureServerIsClean(server);
    });

    test('fallible rpc', async () => {
      const serviceDefs = { test: FallibleServiceConstructor() };
      const server = await createServer(serverTransport, serviceDefs);
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
      await server.close();
      ensureServerIsClean(server);
    });

    test('rpc with binary (uint8array)', async () => {
      const serviceDefs = { test: BinaryFileServiceConstructor() };
      const server = await createServer(serverTransport, serviceDefs);
      const client = createClient<typeof server>(clientTransport);
      const result = await client.test.getFile.rpc({ file: 'test.py' });
      assert(result.ok);
      assert(result.payload.contents instanceof Uint8Array);
      expect(new TextDecoder().decode(result.payload.contents)).toStrictEqual(
        'contents for file test.py',
      );
      await server.close();
      ensureServerIsClean(server);
    });

    test('stream', async () => {
      const serviceDefs = { test: TestServiceConstructor() };
      const server = await createServer(serverTransport, serviceDefs);
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
      await server.close();
      ensureServerIsClean(server);
    });

    test('fallible stream', async () => {
      const serviceDefs = { test: FallibleServiceConstructor() };
      const server = await createServer(serverTransport, serviceDefs);
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
      await server.close();
      ensureServerIsClean(server);
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
      const server = await createServer(serverTransport, serviceDefs);
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

      await client1Transport.close();
      await client2Transport.close();
      await serverTransport.close();
      ensureTransportIsClean(client1Transport);
      ensureTransportIsClean(client2Transport);
      ensureTransportIsClean(serverTransport);
      await server.close();
      ensureServerIsClean(server);
    });

    test('message order is preserved in the face of disconnects', async () => {
      const serviceDefs = { test: OrderingServiceConstructor() };
      const server = await createServer(serverTransport, serviceDefs);
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
      await server.close();
      ensureServerIsClean(server);
    });

    const CONCURRENCY = 10;
    test('concurrent rpcs', async () => {
      const serviceDefs = { test: OrderingServiceConstructor() };
      const server = await createServer(serverTransport, serviceDefs);
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
      await server.close();
      ensureServerIsClean(server);
    });

    test('concurrent streams', async () => {
      const serviceDefs = { test: TestServiceConstructor() };
      const server = await createServer(serverTransport, serviceDefs);
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

      await server.close();
      ensureServerIsClean(server);
    });
  },
);
