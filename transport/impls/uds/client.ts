import { Socket } from 'node:net';
import { UdsConnection } from './connection';
import { TransportClientId } from '../../message';
import { ClientTransport } from '../../client';
import { ProvidedClientTransportOptions } from '../../options';

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
    this.log?.info(`establishing a new uds to ${to}`, {
      clientId: this.clientId,
      connectedTo: to,
    });

    const sock = await new Promise<Socket>((resolve, reject) => {
      const sock = new Socket();
      sock.on('connect', () => resolve(sock));
      sock.on('error', (err) => reject(err));
      sock.connect(this.path);
    });

    return new UdsConnection(sock);
  }
}
