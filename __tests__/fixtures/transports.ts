import { Connection, Transport } from '../../transport';
import http from 'node:http';
import net from 'node:net';
import stream from 'node:stream';
import {
  createWebSocketServer,
  createWsTransports,
  getUnixSocketPath,
  onUdsServeReady,
  onWsServerReady,
} from '../../util/testHelpers';
import { UnixDomainSocketClientTransport } from '../../transport/impls/uds/client';
import { UnixDomainSocketServerTransport } from '../../transport/impls/uds/server';
import { StdioTransport } from '../../transport/impls/stdio/stdio';

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
      await onUdsServeReady(server, socketPath);
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
  {
    name: 'node stream',
    setup: async () => {
      const clientToServer = new stream.PassThrough();
      const serverToClient = new stream.PassThrough();
      return {
        cleanup: async () => {
          clientToServer.end();
          serverToClient.end();
        },
        getTransports: () => [
          new StdioTransport('client', clientToServer, serverToClient),
          new StdioTransport('server', serverToClient, clientToServer),
        ],
      };
    },
  },
];
