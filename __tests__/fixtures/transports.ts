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
import { TransportOptions } from '../../transport/transport';
import { WebSocketClientTransport } from '../../transport/impls/ws/client';
import { WebSocketServerTransport } from '../../transport/impls/ws/server';

export type ValidTransports = 'ws' | 'unix sockets';
export const transports: Array<{
  name: ValidTransports;
  setup: (opts?: Partial<TransportOptions>) => Promise<{
    getClientTransport: (id: TransportClientId) => ClientTransport<Connection>;
    getServerTransport: () => ServerTransport<Connection>;
    simulatePhantomDisconnect: () => void;
    cleanup: () => Promise<void>;
  }>;
}> = [
  {
    name: 'ws',
    setup: async (opts) => {
      const server = http.createServer();
      const port = await onWsServerReady(server);
      const wss = await createWebSocketServer(server);

      const clients: WebSocketClientTransport[] = [];
      return {
        simulatePhantomDisconnect() {
          for (const serverConn of wss.clients) {
            serverConn.removeAllListeners('message');
          }

          for (const client of clients) {
            for (const conn of client.connections.values()) {
              conn.ws.removeAllListeners('message');
            }
          }
        },
        getClientTransport: (id) => {
          const clientTransport = new WebSocketClientTransport(
            () => createLocalWebSocketClient(port),
            id,
            'SERVER',
            opts,
          );
          clients.push(clientTransport);
          return clientTransport;
        },
        getServerTransport: () =>
          new WebSocketServerTransport(wss, 'SERVER', opts),
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
      const server = net.createServer();
      await onUdsServeReady(server, socketPath);

      const transports: (
        | UnixDomainSocketClientTransport
        | UnixDomainSocketServerTransport
      )[] = [];
      return {
        simulatePhantomDisconnect() {
          for (const transport of transports) {
            for (const conn of transport.connections.values()) {
              conn.sock.pause();
            }
          }
        },
        getClientTransport: (id) => {
          const clientTransport = new UnixDomainSocketClientTransport(
            socketPath,
            id,
            'SERVER',
            opts,
          );
          transports.push(clientTransport);
          return clientTransport;
        },
        getServerTransport: () => {
          const serverTransport = new UnixDomainSocketServerTransport(
            server,
            'SERVER',
            opts,
          );
          transports.push(serverTransport);
          return serverTransport;
        },
        cleanup: async () => {
          server.close();
        },
      };
    },
  },
];
