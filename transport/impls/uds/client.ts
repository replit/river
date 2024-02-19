import { Transport, TransportClientId } from '../..';
import { createConnection } from 'node:net';
import { log } from '../../../logging';
import { UdsConnection } from './connection';
import { TransportOptions } from '../../transport';

export class UnixDomainSocketClientTransport extends Transport<UdsConnection> {
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
    const sock = createConnection(this.path);
    const conn = new UdsConnection(sock);
    this.onConnect(conn, to);
    conn.onData((data) => this.handleMsg(this.parseMsg(data)));
    const cleanup = () => {
      this.onDisconnect(conn, to);
      this.connect(to);
    };

    sock.on('close', cleanup);
    sock.on('error', (err) => {
      log?.warn(
        `${this.clientId} -- socket error in connection (id: ${conn.id}) to ${to}: ${err}`,
      );
      cleanup();
    });

    return conn;
  }
}
