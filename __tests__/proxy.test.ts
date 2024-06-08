// test a ws <-> uds multiplex proxy (many uds servers behind a ws server so there is only a single ws connection but multiple servers)
import { describe, test, assert, expect } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import {
  createLocalWebSocketClient,
  createWebSocketServer,
  getUnixSocketPath,
  onUdsServeReady,
  onWsServerReady,
} from '../util/testHelpers';
import { BinaryCodec } from '../codec';
import { Value } from '@sinclair/typebox/value';
import { OpaqueTransportMessageSchema } from '../transport';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import { createClient, createServer } from '../router';
import { TestServiceSchema } from './fixtures/services';
import { testFinishesCleanly } from './fixtures/cleanup';
import { UnixDomainSocketServerTransport } from '../transport/impls/uds/server';
import { MessageFramer } from '../transport/transforms/messageFraming';

describe('proxy', () => {
  test('ws <-> uds proxy works', async ({ onTestFinished }) => {
    // Setup uds server
    const socketPath = getUnixSocketPath();
    const udsServer = net.createServer();
    await onUdsServeReady(udsServer, socketPath);

    // setup ws server (acting as a proxy)
    const proxyServer = http.createServer();
    const port = await onWsServerReady(proxyServer);
    const wss = createWebSocketServer(proxyServer);

    // dumb proxy
    // assume that we are using the binary msgpack protocol
    wss.on('connection', (ws) => {
      const framer = MessageFramer.createFramedStream();
      ws.onmessage = (msg) => {
        const data = msg.data as Uint8Array;
        const res = BinaryCodec.fromBuffer(data);
        if (!res) return;
        if (!Value.Check(OpaqueTransportMessageSchema, res)) {
          return;
        }

        uds.write(MessageFramer.write(data));
      };

      // forward messages from uds servers to ws
      const uds = net.createConnection(socketPath);
      uds.pipe(framer).on('data', (data: Uint8Array) => {
        const res = BinaryCodec.fromBuffer(data);
        if (!res) return;
        if (!Value.Check(OpaqueTransportMessageSchema, res)) {
          return;
        }

        ws.send(data);
      });

      ws.onclose = () => {
        uds.destroy();
      };
    });

    // setup transports
    const serverTransport = new UnixDomainSocketServerTransport(
      udsServer,
      'uds',
      { codec: BinaryCodec },
    );
    const services = { test: TestServiceSchema };
    const server = createServer(serverTransport, services);
    const clientTransport = new WebSocketClientTransport(
      () => Promise.resolve(createLocalWebSocketClient(port)),
      'ws',
      { codec: BinaryCodec },
    );
    const client = createClient<typeof services>(
      clientTransport,
      serverTransport.clientId,
    );
    onTestFinished(async () => {
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });

      udsServer.close();
      wss.close();
      proxyServer.close();
    });

    // test
    const result = await client.test.add.rpc({ n: 3 });
    assert(result.ok);
    expect(result.payload).toStrictEqual({ result: 3 });
  });
});
