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
import {
  type ApplicationErrorCodeSchemas,
  TransportClientId,
} from '../../transport/message';
import { ClientTransport } from '../../transport/client';
import { Connection } from '../../transport/connection';
import { ServerTransport } from '../../transport/server';
import type { TSchema } from 'typebox';

export type ValidTransports = 'ws' | 'mock';

export interface TestTransportOptions {
  client?: ProvidedClientTransportOptions;
  server?: ProvidedServerTransportOptions;
}

export interface TestSetupHelpers {
  getClientTransport: <
    RejectionCodeSchemas extends ApplicationErrorCodeSchemas = [],
  >(
    id: TransportClientId,
    handshakeOptions?: ClientHandshakeOptions<TSchema, RejectionCodeSchemas>,
  ) => ClientTransport<Connection, RejectionCodeSchemas>;
  getServerTransport: <
    MetadataSchema extends TSchema = TSchema,
    ParsedMetadata extends object = object,
    RejectionCodeSchemas extends ApplicationErrorCodeSchemas = [],
  >(
    id?: TransportClientId,
    handshakeOptions?: ServerHandshakeOptions<
      MetadataSchema,
      ParsedMetadata,
      RejectionCodeSchemas
    >,
  ) => ServerTransport<
    Connection,
    MetadataSchema,
    ParsedMetadata,
    RejectionCodeSchemas
  >;
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

      /* eslint-disable @typescript-eslint/no-explicit-any */
      const transports: Array<
        WebSocketClientTransport<any> | WebSocketServerTransport<any, any, any>
      > = [];
      /* eslint-enable @typescript-eslint/no-explicit-any */

      return {
        simulatePhantomDisconnect() {
          for (const transport of transports) {
            for (const conn of getTransportConnections(transport)) {
              conn.ws.onmessage = null;
            }
          }
        },
        getClientTransport: <
          RejectionCodeSchemas extends ApplicationErrorCodeSchemas = [],
        >(
          id: TransportClientId,
          handshakeOptions?: ClientHandshakeOptions<
            TSchema,
            RejectionCodeSchemas
          >,
        ) => {
          const clientTransport =
            new WebSocketClientTransport<RejectionCodeSchemas>(
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
          RejectionCodeSchemas extends ApplicationErrorCodeSchemas = [],
        >(
          id = 'SERVER',
          handshakeOptions:
            | ServerHandshakeOptions<
                MetadataSchema,
                ParsedMetadata,
                RejectionCodeSchemas
              >
            | undefined,
        ) => {
          const serverTransport = new WebSocketServerTransport<
            MetadataSchema,
            ParsedMetadata,
            RejectionCodeSchemas
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
            ParsedMetadata,
            RejectionCodeSchemas
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
