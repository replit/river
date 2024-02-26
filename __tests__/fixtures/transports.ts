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
    cleanup: () => Promise<void>;
  }>;
}> = [
  {
    name: 'ws',
    setup: async (opts) => {
      const server = http.createServer();
      const port = await onWsServerReady(server);
      const wss = await createWebSocketServer(server);
      const cleanup = async () => {
        wss.close();
        server.close();
      };
      return {
        getClientTransport: (id) =>
          new WebSocketClientTransport(
            () => createLocalWebSocketClient(port),
            id,
            'SERVER',
            opts,
          ),
        getServerTransport: () =>
          new WebSocketServerTransport(wss, 'SERVER', opts),
        cleanup,
      };
    },
  },
  {
    name: 'unix sockets',
    setup: async (opts) => {
      const socketPath = getUnixSocketPath();
      const server = net.createServer();
      await onUdsServeReady(server, socketPath);
      return {
        getClientTransport: (id) =>
          new UnixDomainSocketClientTransport(socketPath, id, 'SERVER', opts),
        getServerTransport: () =>
          new UnixDomainSocketServerTransport(server, 'SERVER', opts),
        cleanup: async () => {
          server.close();
        },
      };
    },
  },
];
