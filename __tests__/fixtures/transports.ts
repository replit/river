import {
  ClientTransport,
  Connection,
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
import { ProvidedTransportOptions } from '../../transport/transport';
import { WebSocketClientTransport } from '../../transport/impls/ws/client';
import { WebSocketServerTransport } from '../../transport/impls/ws/server';

export type ValidTransports = 'ws' | 'unix sockets' | 'node streams';
export const transports: Array<{
  name: ValidTransports;
  setup: (opts?: ProvidedTransportOptions) => Promise<{
    getClientTransport: (id: TransportClientId) => ClientTransport<Connection>;
    getServerTransport: () => ServerTransport<Connection>;
    simulatePhantomDisconnect: () => void;
    restartServer: () => Promise<void>;
    cleanup: () => Promise<void> | void;
  }>;
}> = [
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
              conn.ws.removeAllListeners('message');
            }
          }
        },
        getClientTransport(id) {
          const clientTransport = new WebSocketClientTransport(
            () => Promise.resolve(createLocalWebSocketClient(port)),
            id,
            opts,
          );
          void clientTransport.connect('SERVER');
          transports.push(clientTransport);
          return clientTransport;
        },
        getServerTransport() {
          const serverTransport = new WebSocketServerTransport(
            wss,
            'SERVER',
            opts,
          );
          transports.push(serverTransport);
          return serverTransport;
        },
        async restartServer() {
          for (const transport of transports) {
            if (transport.clientId !== 'SERVER') continue;
            for (const conn of transport.connections.values()) {
              conn.ws.terminate();
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
        cleanup: () => {
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
        getClientTransport(id) {
          const clientTransport = new UnixDomainSocketClientTransport(
            socketPath,
            id,
            opts,
          );
          void clientTransport.connect('SERVER');
          transports.push(clientTransport);
          return clientTransport;
        },
        getServerTransport() {
          const serverTransport = new UnixDomainSocketServerTransport(
            server,
            'SERVER',
            opts,
          );
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

          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
          server = net.createServer();
          await onUdsServeReady(server, socketPath);
        },
        cleanup: () => {
          server.close();
        },
      };
    },
  },
];
