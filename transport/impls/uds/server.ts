import { log } from '../../../logging';
import { type Server, type Socket } from 'node:net';
import { ServerTransport, TransportOptions } from '../../transport';
import { TransportClientId } from '../../message';
import { UdsConnection } from './connection';

export class UnixDomainSocketServerTransport extends ServerTransport<UdsConnection> {
  server: Server;

  constructor(
    server: Server,
    clientId: TransportClientId,
    providedOptions?: Partial<TransportOptions>,
  ) {
    super(clientId, providedOptions);
    this.server = server;
    server.addListener('connection', this.connectionHandler);
    server.on('listening', () => {
      log?.info(`${this.clientId} -- server is listening`);
    });
  }

  connectionHandler = (sock: Socket) => {
    const conn = new UdsConnection(sock);
    this.handleConnection(conn);
    log?.info(
      `${this.clientId} -- new incoming uds connection (id: ${conn.debugId})`,
    );
  };

  close() {
    super.close();
    this.server.removeListener('connection', this.connectionHandler);
  }
}
