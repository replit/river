import { type Server, type Socket } from 'node:net';
import { TransportClientId } from '../../message';
import { UdsConnection } from './connection';
import { ServerTransport } from '../../server';
import { ProvidedServerTransportOptions } from '../../options';

export class UnixDomainSocketServerTransport extends ServerTransport<UdsConnection> {
  server: Server;

  constructor(
    server: Server,
    clientId: TransportClientId,
    providedOptions?: Partial<ProvidedServerTransportOptions>,
  ) {
    super(clientId, providedOptions);
    this.server = server;
    server.addListener('connection', this.connectionHandler);
  }

  connectionHandler = (sock: Socket) => {
    const conn = new UdsConnection(sock);
    this.handleConnection(conn);
  };

  close() {
    super.close();
    this.server.removeListener('connection', this.connectionHandler);
  }
}
