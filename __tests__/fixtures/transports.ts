import {
  ClientTransport,
  Connection,
  ServerTransport,
  TransportClientId,
} from '../../transport';
import http from 'node:http';
import {
  createLocalWebSocketClient,
  createWebSocketServer,
  getTransportConnections,
  onWsServerReady,
} from '../../util/testHelpers';
import {
  ClientTransportOptions,
  ServerTransportOptions,
} from '../../transport';
import { WebSocketClientTransport } from '../../transport/impls/ws/client';
import { WebSocketServerTransport } from '../../transport/impls/ws/server';
import {
  ClientHandshakeOptions,
  ServerHandshakeOptions,
} from '../../router/handshake';

export type ValidTransports = 'ws';

export interface TestTransportOptions {
  client?: ClientTransportOptions;
  server?: ServerTransportOptions;
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
            for (const conn of getTransportConnections(transport)) {
              conn.ws.onmessage = null;
            }
          }
        },
        getClientTransport: (id, handshakeOptions) => {
          const clientTransport = new WebSocketClientTransport(
            () => Promise.resolve(createLocalWebSocketClient(port)),
            id,
            opts?.client,
          );

          if (handshakeOptions) {
            clientTransport.extendHandshake(handshakeOptions);
          }

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
          return serverTransport as ServerTransport<Connection>;
        },
        async restartServer() {
          for (const transport of transports) {
            if (transport.clientId !== 'SERVER') continue;
            transport.close();
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
];
