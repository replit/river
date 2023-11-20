import { afterAll, assert, describe, expect, test } from 'vitest';
import {
  createWebSocketServer,
  createWsTransports,
  onServerReady,
} from '../testUtils';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import http from 'http';
import {
  DIV_BY_ZERO,
  FallibleServiceConstructor,
  OrderingServiceConstructor,
  STREAM_ERROR,
  TestServiceConstructor,
} from './fixtures';
import { UNCAUGHT_ERROR } from '../router/result';

describe('client <-> server integration test', async () => {
  const server = http.createServer();
  const port = await onServerReady(server);
  const webSocketServer = await createWebSocketServer(server);

  afterAll(() => {
    webSocketServer.clients.forEach((socket) => {
      socket.close();
    });
    server.close();
  });

  test('rpc', async () => {
    const [clientTransport, serverTransport] = createWsTransports(
      port,
      webSocketServer,
    );
    const serviceDefs = { test: TestServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);
    const result = await client.test.add({ n: 3 });
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 3 });
  });

  test('fallible rpc', async () => {
    const [clientTransport, serverTransport] = createWsTransports(
      port,
      webSocketServer,
    );
    const serviceDefs = { test: FallibleServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);
    const result = await client.test.divide({ a: 10, b: 2 });
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 5 });
    const result2 = await client.test.divide({ a: 10, b: 0 });
    assert(!result2.ok);
    expect(result2.payload).toStrictEqual({
      code: DIV_BY_ZERO,
      message: 'Cannot divide by zero',
      extras: {
        test: 'abc',
      },
    });
  });

  test('stream', async () => {
    const [clientTransport, serverTransport] = createWsTransports(
      port,
      webSocketServer,
    );
    const serviceDefs = { test: TestServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    const [input, output, close] = await client.test.echo();
    input.push({ msg: 'abc', ignore: false });
    input.push({ msg: 'def', ignore: true });
    input.push({ msg: 'ghi', ignore: false });
    input.end();

    const result1 = await output.next().then((res) => res.value);
    assert(result1.ok);
    expect(result1.payload).toStrictEqual({ response: 'abc' });

    const result2 = await output.next().then((res) => res.value);
    assert(result2.ok);
    expect(result2.payload).toStrictEqual({ response: 'ghi' });

    close();
  });

  test('fallible stream', async () => {
    const [clientTransport, serverTransport] = createWsTransports(
      port,
      webSocketServer,
    );
    const serviceDefs = { test: FallibleServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    const [input, output, close] = await client.test.echo();
    input.push({ msg: 'abc', throwResult: false, throwError: false });
    const result1 = await output.next().then((res) => res.value);
    assert(result1 && result1.ok);
    expect(result1.payload).toStrictEqual({ response: 'abc' });

    input.push({ msg: 'def', throwResult: true, throwError: false });
    const result2 = await output.next().then((res) => res.value);
    assert(result2 && !result2.ok);
    expect(result2.payload.code).toStrictEqual(STREAM_ERROR);

    input.push({ msg: 'ghi', throwResult: false, throwError: true });
    const result3 = await output.next().then((res) => res.value);
    assert(result3 && !result3.ok);
    expect(result3.payload).toStrictEqual({
      code: UNCAUGHT_ERROR,
      message: 'some message',
    });
    close();
  });

  test('message order is preserved in the face of disconnects', async () => {
    const [clientTransport, serverTransport] = createWsTransports(
      port,
      webSocketServer,
    );
    const serviceDefs = { test: OrderingServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    const expected: number[] = [];
    for (let i = 0; i < 50; i++) {
      expected.push(i);

      if (i == 10) {
        clientTransport.ws?.close();
      }

      if (i == 42) {
        clientTransport.ws?.terminate();
      }

      await client.test.add({
        n: i,
      });
    }

    const res = await client.test.getAll({});
    assert(res.ok);
    return expect(res.payload.msgs).toStrictEqual(expected);
  });

  const CONCURRENCY = 10;
  test('concurrent rpcs', async () => {
    const [clientTransport, serverTransport] = createWsTransports(
      port,
      webSocketServer,
    );
    const serviceDefs = { test: OrderingServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    const promises = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      promises.push(client.test.add({ n: i }));
    }

    for (let i = 0; i < CONCURRENCY; i++) {
      const result = await promises[i];
      assert(result.ok);
      expect(result.payload).toStrictEqual({ n: i });
    }
  });

  test('concurrent streams', async () => {
    const [clientTransport, serverTransport] = createWsTransports(
      port,
      webSocketServer,
    );
    const serviceDefs = { test: TestServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    const openStreams = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      const streamHandle = await client.test.echo();
      const input = streamHandle[0];
      input.push({ msg: `${i}-1`, ignore: false });
      input.push({ msg: `${i}-2`, ignore: false });
      openStreams.push(streamHandle);
    }

    for (let i = 0; i < CONCURRENCY; i++) {
      const output = openStreams[i][1];
      const result1 = await output.next().then((res) => res.value);
      assert(result1.ok);
      expect(result1.payload).toStrictEqual({ response: `${i}-1` });

      const result2 = await output.next().then((res) => res.value);
      assert(result2.ok);
      expect(result2.payload).toStrictEqual({ response: `${i}-2` });
    }

    // cleanup
    for (let i = 0; i < CONCURRENCY; i++) {
      const [input, _output, close] = openStreams[i];
      input.end();
      close();
    }
  });
});
