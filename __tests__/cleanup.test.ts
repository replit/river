import { afterAll, assert, describe, expect, test } from 'vitest';
import http from 'node:http';
import {
  createWebSocketServer,
  createWsTransports,
  iterNext,
  onWsServerReady,
} from '../util/testHelpers';
import {
  SubscribableServiceConstructor,
  TestServiceConstructor,
  UploadableServiceConstructor,
} from './fixtures/services';
import { createClient, createServer } from '../router';
import {
  ensureServerIsClean,
  ensureTransportQueuesAreEventuallyEmpty,
  waitFor,
} from './fixtures/cleanup';
import { buildServiceDefs } from '../router/defs';

describe('procedures should leave no trace after finishing', async () => {
  const httpServer = http.createServer();
  const port = await onWsServerReady(httpServer);
  const webSocketServer = await createWebSocketServer(httpServer);
  const getTransports = () => createWsTransports(port, webSocketServer);

  afterAll(() => {
    webSocketServer.close();
    httpServer.close();
  });

  test('closing a transport from the client cleans up connection on the server', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
    const server = createServer(serverTransport, serviceDefs);
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
    await waitFor(() =>
      expect(
        serverTransport.connections.size,
        'server should cleanup connection after client closes',
      ).toEqual(0),
    );
  });

  test('closing a transport from the server cleans up connection on the client', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
    const server = createServer(serverTransport, serviceDefs);
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
    await waitFor(() =>
      expect(
        clientTransport.connections.size,
        'client should cleanup connection after server closes',
      ).toEqual(0),
    );
  });

  test('rpc', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
    const server = createServer(serverTransport, serviceDefs);
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
    const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
    const server = createServer(serverTransport, serviceDefs);
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
    await waitFor(() => expect(server.streams.size).toEqual(1));
    input.end();
    // ensure we no longer have any streams since the input was closed.
    await waitFor(() => expect(server.streams.size).toEqual(0));

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
    const serviceDefs = buildServiceDefs([SubscribableServiceConstructor()]);
    const server = createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    let serverListeners =
      serverTransport.eventDispatcher.numberOfListeners('message');
    let clientListeners =
      clientTransport.eventDispatcher.numberOfListeners('message');

    // start procedure
    const [subscription, close] = await client.subscribable.value.subscribe({});
    let result = await iterNext(subscription);
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 0 });
    const add1 = await client.subscribable.add.rpc({ n: 1 });
    assert(add1.ok);
    result = await iterNext(subscription);
    assert(result.ok);

    close();
    // end procedure

    // number of message handlers shouldn't increase after subscription ends
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

  test('upload', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = buildServiceDefs([UploadableServiceConstructor()]);
    const server = createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    let serverListeners =
      serverTransport.eventDispatcher.numberOfListeners('message');
    let clientListeners =
      clientTransport.eventDispatcher.numberOfListeners('message');

    // start procedure
    const [addStream, addResult] = await client.uploadable.addMultiple.upload();
    addStream.push({ n: 1 });
    addStream.push({ n: 2 });
    addStream.end();

    const result = await addResult;
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 3 });
    // end procedure

    // number of message handlers shouldn't increase after upload ends
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
