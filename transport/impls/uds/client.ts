import { TransportClientId } from '../..';
import { Socket } from 'node:net';
import { log } from '../../../logging';
import { UdsConnection } from './connection';
import {
  ClientTransport,
  ProvidedClientTransportOptions,
} from '../../transport';

export class UnixDomainSocketClientTransport extends ClientTransport<UdsConnection> {
  path: string;

  constructor(
    socketPath: string,
    clientId: string,
    providedOptions?: ProvidedClientTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.path = socketPath;
  }

  async createNewOutgoingConnection(to: TransportClientId) {
    const oldConnection = this.connections.get(to);
    if (oldConnection) {
      oldConnection.close();
    }

    log?.info(`${this.clientId} -- establishing a new uds to ${to}`);
    const sock = await new Promise<Socket>((resolve, reject) => {
      const sock = new Socket();
      sock.on('connect', () => resolve(sock));
      sock.on('error', (err) => reject(err));
      sock.connect(this.path);
    });

    const conn = new UdsConnection(sock);
    this.handleConnection(conn, to);
    return conn;
  }
}
