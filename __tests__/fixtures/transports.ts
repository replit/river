import {
  ClientTransport,
  Connection,
  OpaqueTransportMessageSchema,
  ServerTransport,
  TransportClientId,
} from '../../transport';
import http from 'node:http';
import net from 'node:net';
import {
  createLocalWebSocketClient,
  createWebSocketServer,
  getUnixSocketPath,
  onUdsServeReady,
  onWsServerReady,
} from '../../util/testHelpers';
import { UnixDomainSocketClientTransport } from '../../transport/impls/uds/client';
import { UnixDomainSocketServerTransport } from '../../transport/impls/uds/server';
import {
  ProvidedClientTransportOptions,
  ProvidedServerTransportOptions,
} from '../../transport/transport';
import { WebSocketClientTransport } from '../../transport/impls/ws/client';
import { WebSocketServerTransport } from '../../transport/impls/ws/server';
import NodeWs from 'ws';
import {
  ClientHandshakeOptions,
  ServerHandshakeOptions,
} from '../../router/handshake';
import { MessageFramer } from '../../transport/transforms/messageFraming';
import { BinaryCodec } from '../../codec';
import { Value } from '@sinclair/typebox/value';

export type ValidTransports = 'ws' | 'unix sockets' | 'ws + uds proxy';

export interface TestTransportOptions {
  client?: ProvidedClientTransportOptions;
  server?: ProvidedServerTransportOptions;
}

export interface TestSetupHelpers {
  getClientTransport: (
    id: TransportClientId,
    handshakeOptions?: ClientHandshakeOptions,
  ) => ClientTransport<Connection>;
  getServerTransport: (
    handshakeOptions?: ServerHandshakeOptions,
  ) => ServerTransport<Connection>;
  simulatePhantomDisconnect: () => void;
  restartServer: () => Promise<void>;
  cleanup: () => Promise<void> | void;
}

export interface TransportMatrixEntry {
  name: ValidTransports;
  setup: (opts?: TestTransportOptions) => Promise<TestSetupHelpers>;
}

export const transports: Array<TransportMatrixEntry> = [
  {
    name: 'ws',
    setup: async (opts) => {
      let server = http.createServer();
      const port = await onWsServerReady(server);
      let wss = createWebSocketServer(server);

      const transports: Array<
        WebSocketClientTransport | WebSocketServerTransport
      > = [];
      return {
        simulatePhantomDisconnect() {
          for (const transport of transports) {
            for (const conn of transport.connections.values()) {
              conn.ws.onmessage = null;
            }
          }
        },
        getClientTransport(id, handshakeOptions) {
          const clientTransport = new WebSocketClientTransport(
            () => Promise.resolve(createLocalWebSocketClient(port)),
            id,
            opts?.client,
          );

          if (handshakeOptions) {
            clientTransport.extendHandshake(handshakeOptions);
          }

          void clientTransport.connect('SERVER');

          transports.push(clientTransport);
          return clientTransport;
        },
        getServerTransport(handshakeOptions) {
          const serverTransport = new WebSocketServerTransport(
            wss,
            'SERVER',
            opts?.server,
          );

          if (handshakeOptions) {
            serverTransport.extendHandshake(handshakeOptions);
          }

          transports.push(serverTransport);
          return serverTransport;
        },
        async restartServer() {
          for (const transport of transports) {
            if (transport.clientId !== 'SERVER') continue;
            for (const conn of transport.connections.values()) {
              (conn.ws as NodeWs).terminate();
            }
          }

          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
          server = http.createServer();
          await new Promise<void>((resolve) => {
            server.listen(port, resolve);
          });
          wss = createWebSocketServer(server);
        },
        cleanup: async () => {
          wss.close();
          server.close();
        },
      };
    },
  },
  {
    name: 'unix sockets',
    setup: async (opts) => {
      const socketPath = getUnixSocketPath();
      let server = net.createServer();
      await onUdsServeReady(server, socketPath);

      const transports: Array<
        UnixDomainSocketClientTransport | UnixDomainSocketServerTransport
      > = [];
      return {
        simulatePhantomDisconnect() {
          for (const transport of transports) {
            for (const conn of transport.connections.values()) {
              conn.sock.pause();
            }
          }
        },
        getClientTransport(id, handshakeOptions) {
          const clientTransport = new UnixDomainSocketClientTransport(
            socketPath,
            id,
            opts?.client,
          );

          if (handshakeOptions) {
            clientTransport.extendHandshake(handshakeOptions);
          }

          void clientTransport.connect('SERVER');
          transports.push(clientTransport);
          return clientTransport;
        },
        getServerTransport(handshakeOptions) {
          const serverTransport = new UnixDomainSocketServerTransport(
            server,
            'SERVER',
            opts?.server,
          );

          if (handshakeOptions) {
            serverTransport.extendHandshake(handshakeOptions);
          }

          transports.push(serverTransport);
          return serverTransport;
        },
        async restartServer() {
          for (const transport of transports) {
            if (transport.clientId !== 'SERVER') continue;
            for (const conn of transport.connections.values()) {
              conn.sock.destroy();
            }
          }

          await new Promise((resolve) => server.close(resolve));
          server = net.createServer();
          await onUdsServeReady(server, socketPath);
        },
        cleanup: async () => {
          server.close();
        },
      };
    },
  },
  {
    name: 'ws + uds proxy',
    setup: async (opts) => {
      const socketPath = getUnixSocketPath();
      const udsServer = net.createServer();
      await onUdsServeReady(udsServer, socketPath);

      let proxyServer: http.Server;
      let port: number;
      let wss: NodeWs.Server;

      const codec = opts?.client?.codec ?? BinaryCodec;

      async function setupProxyServer() {
        proxyServer = http.createServer();
        port = await onWsServerReady(proxyServer);
        wss = createWebSocketServer(proxyServer);

        // dumb proxy
        // assume that we are using the binary msgpack protocol
        wss.on('connection', (ws) => {
          const framer = MessageFramer.createFramedStream();
          const uds = net.createConnection(socketPath);
          uds.on('error', (err) => {
            if (err instanceof Error && 'code' in err && err.code === 'EPIPE') {
              // Ignore EPIPE errors
              return;
            }
          });
          ws.onmessage = (msg) => {
            const data = msg.data as Uint8Array;
            const res = codec.fromBuffer(data);
            if (!res) return;
            if (!Value.Check(OpaqueTransportMessageSchema, res)) {
              return;
            }

            uds.write(MessageFramer.write(data));
          };

          // forward messages from uds servers to ws
          uds.pipe(framer).on('data', (data: Uint8Array) => {
            const res = codec.fromBuffer(data);
            if (!res) return;
            if (!Value.Check(OpaqueTransportMessageSchema, res)) {
              return;
            }

            ws.send(data);
          });

          uds.on('close', () => {
            ws.close();
          });

          ws.onclose = () => {
            uds.destroy();
          };
        });
      }

      await setupProxyServer();

      return {
        simulatePhantomDisconnect() {
          // pause the proxy
          for (const conn of wss.clients) {
            conn.pause();
          }
        },
        getClientTransport(id, handshakeOptions) {
          const clientTransport = new WebSocketClientTransport(
            () => Promise.resolve(createLocalWebSocketClient(port)),
            id,
            opts?.client,
          );

          if (handshakeOptions) {
            clientTransport.extendHandshake(handshakeOptions);
          }

          void clientTransport.connect('SERVER');

          return clientTransport;
        },
        getServerTransport(handshakeOptions) {
          const serverTransport = new UnixDomainSocketServerTransport(
            udsServer,
            'SERVER',
            opts?.server,
          );

          if (handshakeOptions) {
            serverTransport.extendHandshake(handshakeOptions);
          }

          return serverTransport;
        },
        async restartServer() {
          for (const conn of wss.clients) {
            conn.terminate();
          }

          await new Promise((resolve) => proxyServer.close(resolve));
          await setupProxyServer();
        },
        cleanup: async () => {
          udsServer.close();
          wss.close();
          proxyServer.close();
        },
      };
    },
  },
];
