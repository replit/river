import { TransportClientId } from '../transport';
import { ClientTransport } from '../transport/client';
import { Connection } from '../transport/connection';
import { ServerTransport } from '../transport/server';
import {
  ClientHandshakeOptions,
  ServerHandshakeOptions,
} from '../router/handshake';
import { Observable } from './observable';
import { ProvidedServerTransportOptions } from '../transport/options';
import { TestTransportOptions } from '../__tests__/fixtures/transports';
import { Duplex } from 'node:stream';
import { duplexPair } from './duplexPair';

export class InMemoryConnection extends Connection {
  conn: Duplex;

  constructor(pipe: Duplex) {
    super();
    this.conn = pipe;

    this.conn.on('data', (data: Uint8Array) => {
      for (const cb of this.dataListeners) {
        cb(data);
      }
    });

    this.conn.on('end', () => {
      for (const cb of this.closeListeners) {
        cb();
      }
    });

    this.conn.on('error', (err) => {
      for (const cb of this.errorListeners) {
        cb(err);
      }
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
    });
  }
}

interface BidiConnection {
  clientToServer: Duplex;
  serverToClient: Duplex;
  handled: boolean;
}

export function createMockTransportNetwork(opts?: TestTransportOptions): {
  getClientTransport: (
    id: TransportClientId,
    handshakeOptions?: ClientHandshakeOptions,
  ) => ClientTransport<InMemoryConnection>;
  getServerTransport: (
    handshakeOptions?: ServerHandshakeOptions,
  ) => ServerTransport<InMemoryConnection>;
  simulatePhantomDisconnect: () => void;
  restartServer: () => Promise<void>;
  cleanup: () => Promise<void> | void;
} {
  // client id -> [client->server, server->client]
  const connections = new Observable<Record<TransportClientId, BidiConnection>>(
    {},
  );

  const transports: Array<MockClientTransport | MockServerTransport> = [];
  class MockClientTransport extends ClientTransport<InMemoryConnection> {
    async createNewOutgoingConnection(): Promise<InMemoryConnection> {
      const [clientToServer, serverToClient] = duplexPair();

      // await with some jitter to simulate network latency
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));

      connections.set((prev) => ({
        ...prev,
        [this.clientId]: {
          clientToServer,
          serverToClient,
          handled: false,
        },
      }));

      return new InMemoryConnection(clientToServer);
    }
  }

  class MockServerTransport extends ServerTransport<InMemoryConnection> {
    subscribeCleanup: () => void;

    constructor(
      clientId: TransportClientId,
      options?: ProvidedServerTransportOptions,
    ) {
      super(clientId, options);

      this.subscribeCleanup = connections.observe((conns) => {
        // look for any unhandled connections
        for (const conn of Object.values(conns)) {
          if (conn.handled) {
            continue;
          }

          // if we find one, handle it
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
    getClientTransport: (id, handshakeOptions) => {
      const clientTransport = new MockClientTransport(id, opts?.client);
      if (handshakeOptions) {
        clientTransport.extendHandshake(handshakeOptions);
      }

      transports.push(clientTransport);

      return clientTransport;
    },
    getServerTransport: (handshakeOptions) => {
      const serverTransport = new MockServerTransport('SERVER', opts?.server);
      if (handshakeOptions) {
        serverTransport.extendHandshake(handshakeOptions);
      }

      transports.push(serverTransport);

      return serverTransport;
    },
    simulatePhantomDisconnect() {
      for (const conn of Object.values(connections.get())) {
        conn.serverToClient.pause();
      }
    },
    async restartServer() {
      for (const transport of transports) {
        if (transport.clientId !== 'SERVER') continue;
        transport.close();
      }

      // kill all connections while we're at it
      for (const conn of Object.values(connections.get())) {
        conn.serverToClient.end();
        conn.clientToServer.end();
      }
    },
    cleanup() {
      for (const conn of Object.values(connections.get())) {
        conn.serverToClient.end();
        conn.clientToServer.end();
      }
    },
  };
}
