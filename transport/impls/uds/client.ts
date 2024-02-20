import { TransportClientId } from '../..';
import { Socket } from 'node:net';
import { log } from '../../../logging';
import { UdsConnection } from './connection';
import { ClientTransport, TransportOptions } from '../../transport';

export class UnixDomainSocketClientTransport extends ClientTransport<UdsConnection> {
  path: string;
  serverId: TransportClientId;

  constructor(
    socketPath: string,
    clientId: string,
    serverId: TransportClientId,
    providedOptions?: Partial<TransportOptions>,
  ) {
    super(clientId, providedOptions);
    this.path = socketPath;
    this.serverId = serverId;
    this.connect(serverId);
  }

  async createNewOutgoingConnection(to: string) {
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
    conn.addDataListener((data) => this.handleMsg(this.parseMsg(data)));
    const cleanup = () => {
      this.onDisconnect(conn, to);
      this.connect(to);
    };

    sock.on('close', cleanup);
    sock.on('error', (err) => {
      log?.warn(
        `${this.clientId} -- socket error in connection (id: ${conn.debugId}) to ${to}: ${err}`,
      );
    });

    this.onConnect(conn, to);
    return conn;
  }
}
