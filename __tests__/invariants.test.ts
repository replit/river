import { afterAll, assert, describe, expect, test } from 'vitest';
import http from 'http';
import {
  createWebSocketServer,
  createWsTransports,
  iterNext,
  onServerReady,
} from '../util/testHelpers';
import {
  SubscribableServiceConstructor,
  TestServiceConstructor,
} from './fixtures/services';
import { createClient, createServer } from '../router';
import {
  ensureServerIsClean,
  ensureTransportQueuesAreEventuallyEmpty,
  waitUntil,
} from './fixtures/cleanup';

describe('procedures should leave no trace after finishing', async () => {
  const httpServer = http.createServer();
  const port = await onServerReady(httpServer);
  const webSocketServer = await createWebSocketServer(httpServer);
  const getTransports = () => createWsTransports(port, webSocketServer);

  afterAll(() => {
    webSocketServer.close();
    httpServer.close();
  });

  test('closing a transport from the client cleans up connection on the server', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = { test: TestServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    expect(clientTransport.connections.size).toEqual(0);
    expect(serverTransport.connections.size).toEqual(0);

    // start procedure
    await client.test.add.rpc({ n: 3 });
    // end procedure

    expect(clientTransport.connections.size).toEqual(1);
    expect(serverTransport.connections.size).toEqual(1);

    // should be back to 0 connections after client closes
    clientTransport.close();
    expect(clientTransport.connections.size).toEqual(0);
    await waitUntil(
      () => serverTransport.connections.size,
      0,
      'server should cleanup connection after client closes',
    );
  });

  test('closing a transport from the server cleans up connection on the client', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = { test: TestServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    expect(clientTransport.connections.size).toEqual(0);
    expect(serverTransport.connections.size).toEqual(0);

    // start procedure
    await client.test.add.rpc({ n: 3 });
    // end procedure

    expect(clientTransport.connections.size).toEqual(1);
    expect(serverTransport.connections.size).toEqual(1);

    // should be back to 0 connections after client closes
    serverTransport.close();
    expect(serverTransport.connections.size).toEqual(0);
    await waitUntil(
      () => clientTransport.connections.size,
      0,
      'client should cleanup connection after server closes',
    );
  });

  test('rpc', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = { test: TestServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    let serverListeners =
      serverTransport.eventDispatcher.numberOfListeners('message');
    let clientListeners =
      clientTransport.eventDispatcher.numberOfListeners('message');

    // start procedure
    await client.test.add.rpc({ n: 3 });
    // end procedure

    // number of message handlers shouldn't increase after rpc
    expect(
      serverTransport.eventDispatcher.numberOfListeners('message'),
    ).toEqual(serverListeners);
    expect(
      clientTransport.eventDispatcher.numberOfListeners('message'),
    ).toEqual(clientListeners);

    // check number of connections
    expect(serverTransport.connections.size).toEqual(1);
    expect(clientTransport.connections.size).toEqual(1);
    await ensureTransportQueuesAreEventuallyEmpty(clientTransport);
    await ensureTransportQueuesAreEventuallyEmpty(serverTransport);

    // ensure we have no streams left on the server
    await ensureServerIsClean(server);
  });

  test('stream', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = { test: TestServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    let serverListeners =
      serverTransport.eventDispatcher.numberOfListeners('message');
    let clientListeners =
      clientTransport.eventDispatcher.numberOfListeners('message');

    // start procedure
    const [input, output, close] = await client.test.echo.stream();
    input.push({ msg: '1', ignore: false });
    input.push({ msg: '2', ignore: false, end: true });

    const result1 = await iterNext(output);
    assert(result1.ok);
    expect(result1.payload).toStrictEqual({ response: '1' });

    // ensure we only have one stream despite pushing multiple messages.
    await waitUntil(() => server.streams.size, 1);
    input.end();
    // ensure we no longer have any streams since the input was closed.
    await waitUntil(() => server.streams.size, 0);

    const result2 = await iterNext(output);
    assert(result2.ok);
    expect(result2.payload).toStrictEqual({ response: '2' });

    const result3 = await output.next();
    assert(result3.done);

    close();
    // end procedure

    // number of message handlers shouldn't increase after stream ends
    expect(
      serverTransport.eventDispatcher.numberOfListeners('message'),
    ).toEqual(serverListeners);
    expect(
      clientTransport.eventDispatcher.numberOfListeners('message'),
    ).toEqual(clientListeners);

    // check number of connections
    expect(serverTransport.connections.size).toEqual(1);
    expect(clientTransport.connections.size).toEqual(1);
    await ensureTransportQueuesAreEventuallyEmpty(clientTransport);
    await ensureTransportQueuesAreEventuallyEmpty(serverTransport);

    // ensure we have no streams left on the server
    await ensureServerIsClean(server);
  });

  test('subscription', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = { test: SubscribableServiceConstructor() };
    const server = await createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    let serverListeners =
      serverTransport.eventDispatcher.numberOfListeners('message');
    let clientListeners =
      clientTransport.eventDispatcher.numberOfListeners('message');

    // start procedure
    const [subscription, close] = await client.test.value.subscribe({});
    let result = await iterNext(subscription);
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 0 });

    const add1 = await client.test.add.rpc({ n: 1 });
    assert(add1.ok);

    result = await iterNext(subscription);
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 1 });

    close();
    // end procedure

    // number of message handlers shouldn't increase after stream ends
    expect(
      serverTransport.eventDispatcher.numberOfListeners('message'),
    ).toEqual(serverListeners);
    expect(
      clientTransport.eventDispatcher.numberOfListeners('message'),
    ).toEqual(clientListeners);

    // check number of connections
    expect(serverTransport.connections.size).toEqual(1);
    expect(clientTransport.connections.size).toEqual(1);
    await ensureTransportQueuesAreEventuallyEmpty(clientTransport);
    await ensureTransportQueuesAreEventuallyEmpty(serverTransport);

    // ensure we have no streams left on the server
    await ensureServerIsClean(server);
  });
});