import http from 'node:http';
import {
  createLocalWebSocketClient,
  createWebSocketServer,
  getTransportConnections,
  onWsServerReady,
} from '..';
import { WebSocketClientTransport } from '../../transport/impls/ws/client';
import { WebSocketServerTransport } from '../../transport/impls/ws/server';
import {
  ClientHandshakeOptions,
  ServerHandshakeOptions,
} from '../../router/handshake';
import { createMockTransportNetwork } from './mockTransport';
import {
  ProvidedClientTransportOptions,
  ProvidedServerTransportOptions,
} from '../../transport/options';
import { TransportClientId } from '../../transport/message';
import { ClientTransport } from '../../transport/client';
import { Connection } from '../../transport/connection';
import { ServerTransport } from '../../transport/server';
import { TSchema } from '@sinclair/typebox';

export type ValidTransports = 'ws' | 'mock';

export interface TestTransportOptions {
  client?: ProvidedClientTransportOptions;
  server?: ProvidedServerTransportOptions;
}

export interface TestSetupHelpers {
  getClientTransport: (
    id: TransportClientId,
    handshakeOptions?: ClientHandshakeOptions,
  ) => ClientTransport<Connection>;
  getServerTransport: <
    MetadataSchema extends TSchema = TSchema,
    ParsedMetadata extends object = object,
  >(
    id?: TransportClientId,
    handshakeOptions?: ServerHandshakeOptions<MetadataSchema, ParsedMetadata>,
  ) => ServerTransport<Connection, MetadataSchema, ParsedMetadata>;
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        WebSocketClientTransport | WebSocketServerTransport<any, any>
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

          clientTransport.bindLogger((msg, ctx, level) => {
            if (ctx?.tags?.includes('invariant-violation')) {
              console.error('invariant violation', { msg, ctx, level });
              throw new Error(
                `Invariant violation encountered: [${level}] ${msg}`,
              );
            }
          }, 'debug');

          transports.push(clientTransport);

          return clientTransport;
        },
        getServerTransport: <
          MetadataSchema extends TSchema,
          ParsedMetadata extends object,
        >(
          id = 'SERVER',
          handshakeOptions:
            | ServerHandshakeOptions<MetadataSchema, ParsedMetadata>
            | undefined,
        ) => {
          const serverTransport = new WebSocketServerTransport<
            MetadataSchema,
            ParsedMetadata
          >(wss, id, opts?.server);

          serverTransport.bindLogger((msg, ctx, level) => {
            if (ctx?.tags?.includes('invariant-violation')) {
              console.error('invariant violation', { msg, ctx, level });
              throw new Error(
                `Invariant violation encountered: [${level}] ${msg}`,
              );
            }
          }, 'debug');

          if (handshakeOptions) {
            serverTransport.extendHandshake(handshakeOptions);
          }

          transports.push(serverTransport);

          return serverTransport as ServerTransport<
            Connection,
            MetadataSchema,
            ParsedMetadata
          >;
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
  {
    name: 'mock',
    setup: async (opts) => {
      const network = createMockTransportNetwork(opts);

      return network;
    },
  },
];
