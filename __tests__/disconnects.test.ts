import { afterAll, assert, describe, expect, test, vi } from 'vitest';
import http from 'http';
import {
  createWebSocketServer,
  createWsTransports,
  iterNext,
  onServerReady,
} from '../util/testHelpers';
import { TestServiceConstructor } from './fixtures/services';
import { createClient, createServer } from '../router';
import { ensureServerIsClean } from './fixtures/cleanup';
import { CONNECTION_GRACE_PERIOD_MS } from '../router/client';
import { Err, UNEXPECTED_DISCONNECT } from '../router/result';

describe('procedures should handle unexpected disconnects', async () => {
  const httpServer = http.createServer();
  const port = await onServerReady(httpServer);
  const webSocketServer = await createWebSocketServer(httpServer);
  const getTransports = () => createWsTransports(port, webSocketServer);

  afterAll(() => {
    webSocketServer.close();
    httpServer.close();
  });

  test('rpc', async () => {
    vi.useFakeTimers();
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = { test: TestServiceConstructor() };
    const server = createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    // start procedure
    await client.test.add.rpc({ n: 3 });

    expect(clientTransport.connections.size).toEqual(1);
    expect(serverTransport.connections.size).toEqual(1);

    clientTransport.connections.forEach((conn) => conn.ws.close());
    clientTransport.tryReconnecting = false;
    const procPromise = client.test.add.rpc({ n: 4 });
    // end procedure

    // after we've disconnected, hit end of grace period
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(CONNECTION_GRACE_PERIOD_MS);

    // we should get an error + expect the streams to be cleaned up
    await expect(procPromise).resolves.toMatchObject(
      Err({
        code: UNEXPECTED_DISCONNECT,
      }),
    );

    expect(clientTransport.connections.size).toEqual(0);
    expect(serverTransport.connections.size).toEqual(0);
    await ensureServerIsClean(server);
    vi.useRealTimers();
  });

  test('stream', async () => {
    vi.useFakeTimers();
    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = { test: TestServiceConstructor() };
    const server = createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    // start procedure
    const [input, output] = await client.test.echo.stream();
    input.push({ msg: 'abc', ignore: false });
    const result = await iterNext(output);
    assert(result.ok);

    expect(clientTransport.connections.size).toEqual(1);
    expect(serverTransport.connections.size).toEqual(1);

    clientTransport.connections.forEach((conn) => conn.ws.close());
    clientTransport.tryReconnecting = false;

    const nextResPromise = iterNext(output);
    // end procedure

    // after we've disconnected, hit end of grace period
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(CONNECTION_GRACE_PERIOD_MS);

    // we should get an error + expect the streams to be cleaned up
    await expect(nextResPromise).resolves.toMatchObject(
      Err({
        code: UNEXPECTED_DISCONNECT,
      }),
    );

    expect(clientTransport.connections.size).toEqual(0);
    expect(serverTransport.connections.size).toEqual(0);
    await ensureServerIsClean(server);
    vi.useRealTimers();
  });
});
