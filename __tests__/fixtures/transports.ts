import { Connection, Transport } from '../../transport';
import http from 'http';
import fs from 'fs';
import {
  createWebSocketServer,
  createWsTransports,
  getUnixSocketPath,
  onServerReady,
} from '../../util/testHelpers';
import { UnixDomainSocketClientTransport } from '../../transport/impls/unixsocket/client';
import { UnixDomainSocketServerTransport } from '../../transport/impls/unixsocket/server';

export const transports: Array<{
  name: string;
  setup: () => Promise<{
    // client, server
    getTransports: () => [Transport<Connection>, Transport<Connection>];
    before?: () => Promise<void>;
    cleanup: () => Promise<void>;
  }>;
}> = [
  {
    name: 'ws',
    setup: async () => {
      const server = http.createServer();
      const port = await onServerReady(server);
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
      let socketPath: string;
      return {
        before: async () => {
          socketPath = getUnixSocketPath();
        },
        cleanup: async () => {
          if (fs.existsSync(socketPath)) {
            await fs.promises.unlink(socketPath);
          }
        },
        getTransports: () => [
          new UnixDomainSocketClientTransport(socketPath, 'client', 'SERVER'),
          new UnixDomainSocketServerTransport(socketPath, 'SERVER'),
        ],
      };
    },
  },
];
