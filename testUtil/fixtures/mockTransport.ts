import { Transport, TransportClientId } from '../../transport';
import type { CustomHandshakeErrorCodeSchema } from '../../transport/message';
import { ClientTransport } from '../../transport/client';
import { Connection } from '../../transport/connection';
import { ServerTransport } from '../../transport/server';
import { Observable } from '../observable/observable';
import { ProvidedServerTransportOptions } from '../../transport/options';
import { TestSetupHelpers, TestTransportOptions } from './transports';
import { Duplex } from 'node:stream';
import { duplexPair } from '../duplex/duplexPair';
import { nanoid } from 'nanoid';
import type { TSchema } from 'typebox';
import {
  ClientHandshakeOptions,
  ServerHandshakeOptions,
} from '../../router/handshake';
import { NaiveJsonCodec } from '../../codec';
import {
  attachTraceEvents,
  startTraceCase,
  traceWrapCodec,
  tracingEnabled,
} from './trace';

export class InMemoryConnection extends Connection {
  conn: Duplex;

  constructor(pipe: Duplex) {
    super();
    this.conn = pipe;
    this.conn.allowHalfOpen = false;

    this.conn.on('data', (data: Uint8Array) => {
      this.dataListener?.(data);
    });

    this.conn.on('close', () => {
      this.closeListener?.();
    });

    this.conn.on('error', (err) => {
      this.errorListener?.(err);
    });
  }

  send(payload: Uint8Array): boolean {
    setImmediate(() => {
      this.conn.write(payload);
    });

    return true;
  }

  close(): void {
    setImmediate(() => {
      this.conn.end();
      this.conn.emit('close');
    });
  }
}

interface BidiConnection {
  id: string;
  clientToServer: Duplex;
  serverToClient: Duplex;
  clientId: TransportClientId;
  serverId: TransportClientId;
  handled: boolean;
}

// we construct a network of transports connected by node streams here
// so that we can test the transport layer without needing to actually
// use real network/websocket connections
// this is useful for testing the transport layer in isolation
// and allows us to control network conditions in a way that would be
// difficult with real network connections (e.g. simulating a phantom
// disconnect, .pause() vs .removeAllListeners('data'), congestion,
// latency, differences in ws implementations between node and browsers, etc.)
export function createMockTransportNetwork(
  opts?: TestTransportOptions,
): TestSetupHelpers {
  // one trace file per network = per generated test case (no-op unless
  // RIVER_TRACE_DIR is set -- see ./trace.ts)
  startTraceCase();

  // conn id -> [client->server, server->client]
  const connections = new Observable<Record<string, BidiConnection>>({});

  const transports: Array<Transport<InMemoryConnection, string>> = [];
  class MockClientTransport<
    RejectionCodeSchema extends CustomHandshakeErrorCodeSchema,
  > extends ClientTransport<InMemoryConnection, RejectionCodeSchema> {
    async createNewOutgoingConnection(
      to: TransportClientId,
    ): Promise<InMemoryConnection> {
      const [clientToServer, serverToClient] = duplexPair();
      await new Promise((resolve) => setImmediate(resolve));

      const connId = nanoid();
      connections.set((prev) => ({
        ...prev,
        [connId]: {
          id: connId,
          clientToServer,
          serverToClient,
          clientId: this.clientId,
          serverId: to,
          handled: false,
        },
      }));

      return new InMemoryConnection(clientToServer);
    }
  }

  class MockServerTransport<
    MetadataSchema extends TSchema,
    ParsedMetadata extends object,
    RejectionCodeSchema extends CustomHandshakeErrorCodeSchema,
  > extends ServerTransport<
    InMemoryConnection,
    MetadataSchema,
    ParsedMetadata,
    RejectionCodeSchema
  > {
    subscribeCleanup: () => void;

    constructor(
      clientId: TransportClientId,
      options?: ProvidedServerTransportOptions,
    ) {
      super(clientId, options);

      this.subscribeCleanup = connections.observe((conns) => {
        // look for any unhandled connections
        for (const conn of Object.values(conns)) {
          // if we've already handled this connection, skip it
          // or if it's not for us, skip it
          if (conn.handled || conn.serverId !== this.clientId) {
            continue;
          }

          conn.handled = true;
          const connection = new InMemoryConnection(conn.serverToClient);
          this.handleConnection(connection);
        }
      });
    }

    close() {
      this.subscribeCleanup();
      super.close();
    }
  }

  return {
    getClientTransport: <
      RejectionCodeSchema extends CustomHandshakeErrorCodeSchema,
    >(
      id: TransportClientId,
      handshakeOptions?: ClientHandshakeOptions<TSchema, RejectionCodeSchema>,
    ) => {
      const clientTransport = new MockClientTransport<RejectionCodeSchema>(
        id,
        tracingEnabled()
          ? {
              ...opts?.client,
              codec: traceWrapCodec(
                'client',
                opts?.client?.codec ?? NaiveJsonCodec,
              ),
            }
          : opts?.client,
      );
      if (handshakeOptions) {
        clientTransport.extendHandshake(handshakeOptions);
      }

      attachTraceEvents('client', clientTransport);
      transports.push(clientTransport);

      return clientTransport;
    },
    getServerTransport: <
      MetadataSchema extends TSchema,
      ParsedMetadata extends object,
      RejectionCodeSchema extends CustomHandshakeErrorCodeSchema,
    >(
      id = 'SERVER',
      handshakeOptions:
        | ServerHandshakeOptions<
            MetadataSchema,
            ParsedMetadata,
            RejectionCodeSchema
          >
        | undefined,
    ) => {
      const serverTransport = new MockServerTransport<
        MetadataSchema,
        ParsedMetadata,
        RejectionCodeSchema
      >(
        id,
        tracingEnabled()
          ? {
              ...opts?.server,
              codec: traceWrapCodec(
                'server',
                opts?.server?.codec ?? NaiveJsonCodec,
              ),
            }
          : opts?.server,
      );
      if (handshakeOptions) {
        serverTransport.extendHandshake(handshakeOptions);
      }

      attachTraceEvents('server', serverTransport);
      transports.push(serverTransport);

      return serverTransport;
    },
    simulatePhantomDisconnect() {
      for (const conn of Object.values(connections.get())) {
        conn.serverToClient.pause();
        conn.clientToServer.pause();
      }
    },
    async restartServer() {
      for (const transport of transports) {
        if (transport.clientId !== 'SERVER') continue;
        transport.close();
      }

      // kill all connections while we're at it
      for (const conn of Object.values(connections.get())) {
        conn.serverToClient.destroy();
        conn.clientToServer.destroy();
      }
    },
    cleanup() {
      for (const conn of Object.values(connections.get())) {
        conn.serverToClient.destroy();
        conn.clientToServer.destroy();
      }
    },
  };
}
