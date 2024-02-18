import { afterAll, assert, describe, expect, test, vi } from 'vitest';
import http from 'node:http';
import {
  createLocalWebSocketClient,
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
import { ensureServerIsClean, waitFor } from './fixtures/cleanup';
import { Err, UNEXPECTED_DISCONNECT } from '../router/result';
import { WebSocketServerTransport } from '../transport/impls/ws/server';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import { buildServiceDefs } from '../router/defs';
import { DISCONNECT_GRACE_MS } from '../transport/session';

describe('procedures should handle unexpected disconnects', async () => {
  const httpServer = http.createServer();
  const port = await onWsServerReady(httpServer);
  const webSocketServer = await createWebSocketServer(httpServer);
  const getTransports = () => createWsTransports(port, webSocketServer);

  afterAll(() => {
    webSocketServer.close();
    httpServer.close();
  });

  test('rpc', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
    const server = createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    // start procedure
    await client.test.add.rpc({ n: 3 });
    expect(clientTransport.connections.size).toEqual(1);
    expect(serverTransport.connections.size).toEqual(1);

    vi.useFakeTimers();
    clientTransport.connections.forEach((conn) => conn.ws.close());
    clientTransport.tryReconnecting = false;
    const procPromise = client.test.add.rpc({ n: 4 });
    // end procedure

    // after we've disconnected, hit end of grace period
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + 1);

    // we should get an error + expect the streams to be cleaned up
    await expect(procPromise).resolves.toMatchObject(
      Err({
        code: UNEXPECTED_DISCONNECT,
      }),
    );

    vi.useRealTimers();
    waitFor(() => expect(clientTransport.connections.size).toEqual(0));
    waitFor(() => expect(serverTransport.connections.size).toEqual(0));
    await ensureServerIsClean(server);
  });

  test('stream', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
    const server = createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    // start procedure
    const [input, output] = await client.test.echo.stream();
    input.push({ msg: 'abc', ignore: false });
    const result = await iterNext(output);
    assert(result.ok);

    expect(clientTransport.connections.size).toEqual(1);
    expect(serverTransport.connections.size).toEqual(1);

    vi.useFakeTimers();
    clientTransport.connections.forEach((conn) => conn.ws.close());
    clientTransport.tryReconnecting = false;
    const nextResPromise = iterNext(output);
    // end procedure

    // after we've disconnected, hit end of grace period
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);

    // we should get an error + expect the streams to be cleaned up
    await expect(nextResPromise).resolves.toMatchObject(
      Err({
        code: UNEXPECTED_DISCONNECT,
      }),
    );

    vi.useRealTimers();
    waitFor(() => expect(clientTransport.connections.size).toEqual(0));
    waitFor(() => expect(serverTransport.connections.size).toEqual(0));
    await ensureServerIsClean(server);
  });

  test('subscription', async () => {
    const serverTransport = new WebSocketServerTransport(
      webSocketServer,
      'SERVER',
    );
    const client1Transport = new WebSocketClientTransport(
      () => createLocalWebSocketClient(port),
      'client1',
      'SERVER',
    );
    const client2Transport = new WebSocketClientTransport(
      () => createLocalWebSocketClient(port),
      'client2',
      'SERVER',
    );

    const serviceDefs = buildServiceDefs([SubscribableServiceConstructor()]);
    const server = createServer(serverTransport, serviceDefs);
    const client1 = createClient<typeof server>(client1Transport);
    const client2 = createClient<typeof server>(client2Transport);

    // start procedure
    // client1 and client2 both subscribe
    const [subscription1, close1] = await client1.subscribable.value.subscribe(
      {},
    );
    let result = await iterNext(subscription1);
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 0 });

    const [subscription2, _close2] = await client2.subscribable.value.subscribe(
      {},
    );
    result = await iterNext(subscription2);
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 0 });

    // client2 adds a value
    const add1 = await client2.subscribable.add.rpc({ n: 1 });
    assert(add1.ok);

    // both clients should receive the updated value
    result = await iterNext(subscription1);
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 1 });
    result = await iterNext(subscription2);
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 1 });

    // all clients are connected
    expect(client1Transport.connections.size).toEqual(1);
    expect(client2Transport.connections.size).toEqual(1);
    expect(serverTransport.connections.size).toEqual(2);

    // kill the connection for client2
    vi.useFakeTimers();
    client2Transport.connections.forEach((conn) => conn.ws.close());
    client2Transport.tryReconnecting = false;

    // client1 who is still connected can still add values and receive updates
    const add2Promise = client1.subscribable.add.rpc({ n: 2 });

    // after we've disconnected, hit end of grace period
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);

    // we should get an error from the subscription on client2
    const nextResPromise = iterNext(subscription2);
    await expect(nextResPromise).resolves.toMatchObject(
      Err({
        code: UNEXPECTED_DISCONNECT,
      }),
    );
    vi.useRealTimers();

    // client1 who is still connected can still add values and receive updates
    assert((await add2Promise).ok);
    result = await iterNext(subscription1);
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 3 });

    // at this point, only client1 is connected
    expect(client1Transport.connections.size).toEqual(1);
    expect(client2Transport.connections.size).toEqual(0);
    expect(serverTransport.connections.size).toEqual(1);

    // cleanup client1 (client2 is already disconnected)
    close1();
    await client1Transport.close();

    await ensureServerIsClean(server);
  });

  test('upload', async () => {
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = buildServiceDefs([UploadableServiceConstructor()]);
    const server = createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    // start procedure
    const [addStream, addResult] = await client.uploadable.addMultiple.upload();
    addStream.push({ n: 1 });
    addStream.push({ n: 2 });
    // end procedure

    // need to wait for connection to be established
    await waitFor(() => expect(clientTransport.connections.size).toEqual(1));
    await waitFor(() => expect(serverTransport.connections.size).toEqual(1));

    vi.useFakeTimers();
    clientTransport.connections.forEach((conn) => conn.ws.close());
    clientTransport.tryReconnecting = false;

    // after we've disconnected, hit end of grace period
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);

    // we should get an error + expect the streams to be cleaned up
    await expect(addResult).resolves.toMatchObject(
      Err({
        code: UNEXPECTED_DISCONNECT,
      }),
    );
    vi.useRealTimers();

    waitFor(() => expect(clientTransport.connections.size).toEqual(0));
    waitFor(() => expect(serverTransport.connections.size).toEqual(0));
    await ensureServerIsClean(server);
  });
});

describe.todo('procedures should handle unexpected server crashes');
