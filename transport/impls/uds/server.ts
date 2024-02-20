import { Session } from '../../session';
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
    let session: Session<UdsConnection> | undefined = undefined;
    const conn = new UdsConnection(sock);
    log?.info(
      `${this.clientId} -- new incoming uds connection (id: ${conn.debugId})`,
    );

    const client = () => session?.connectedTo ?? 'unknown';
    conn.addDataListener(
      this.receiveBootSequence(conn, (establishedSession) => {
        session = establishedSession;
      }),
    );

    sock.on('close', () => {
      if (!session) return;
      log?.info(
        `${this.clientId} -- uds (id: ${
          conn.debugId
        }) to ${client()} disconnected`,
      );
      this.onDisconnect(conn, session?.connectedTo);
    });

    sock.on('error', (err) => {
      log?.warn(
        `${this.clientId} -- uds (id: ${
          conn.debugId
        }) to ${client()} got an error: ${err}`,
      );
    });
  };

  async createNewOutgoingConnection(to: string): Promise<UdsConnection> {
    const err = `${this.clientId} -- failed to send msg to ${to}, client probably dropped`;
    log?.warn(err);
    throw new Error(err);
  }

  async close() {
    super.close();
    this.server.removeListener('connection', this.connectionHandler);
  }
}
