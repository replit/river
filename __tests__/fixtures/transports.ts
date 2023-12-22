import { Connection, Transport } from '../../transport';
import http from 'node:http';
import net from 'node:net';
import {
  createWebSocketServer,
  createWsTransports,
  getUnixSocketPath,
  onUnixSocketServeReady,
  onWsServerReady,
} from '../../util/testHelpers';
import { UnixDomainSocketClientTransport } from '../../transport/impls/unixsocket/client';
import { UnixDomainSocketServerTransport } from '../../transport/impls/unixsocket/server';

export const transports: Array<{
  name: string;
  setup: () => Promise<{
    // client, server
    getTransports: () => [Transport<Connection>, Transport<Connection>];
    cleanup: () => Promise<void>;
  }>;
}> = [
  {
    name: 'ws',
    setup: async () => {
      const server = http.createServer();
      const port = await onWsServerReady(server);
      const wss = await createWebSocketServer(server);
      const cleanup = async () => {
        wss.close();
        server.close();
      };
      return {
        getTransports: () => createWsTransports(port, wss),
        cleanup,
      };
    },
  },
  {
    name: 'unix sockets',
    setup: async () => {
      const socketPath = getUnixSocketPath();
      const server = net.createServer();
      await onUnixSocketServeReady(server, socketPath);
      return {
        cleanup: async () => {
          server.close();
        },
        getTransports: () => [
          new UnixDomainSocketClientTransport(socketPath, 'client', 'SERVER'),
          new UnixDomainSocketServerTransport(server, 'SERVER'),
        ],
      };
    },
  },
];
