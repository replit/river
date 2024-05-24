import {
  ClientHandshakeOptions,
  ClientTransport,
  Connection,
  ServerHandshakeOptions,
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
import { TSchema } from '@sinclair/typebox';

export type ValidTransports = 'ws' | 'unix sockets';

export interface TestTransportOptions {
  client?: ProvidedClientTransportOptions;
  server?: ProvidedServerTransportOptions;
}

export interface TransportMatrixEntry {
  name: ValidTransports;
  setup: (opts?: TestTransportOptions) => Promise<{
    getClientTransport: (
      id: TransportClientId,
      handshakeOptions?: ClientHandshakeOptions<TSchema>,
    ) => ClientTransport<Connection>;
    getServerTransport: (
      handshakeOptions?: ServerHandshakeOptions<TSchema>,
    ) => ServerTransport<Connection>;
    simulatePhantomDisconnect: () => void;
    restartServer: () => Promise<void>;
    cleanup: () => Promise<void> | void;
  }>;
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
];
