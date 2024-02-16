import { Session } from '../../session';
import { Codec, NaiveJsonCodec } from '../../../codec';
import { log } from '../../../logging';
import { type Server, type Socket } from 'node:net';
import { Transport } from '../../transport';
import { TransportClientId } from '../../message';
import { UdsConnection } from './connection';

interface Options {
  codec: Codec;
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
};

export class UnixDomainSocketServerTransport extends Transport<UdsConnection> {
  server: Server;

  constructor(
    server: Server,
    clientId: TransportClientId,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);
    this.server = server;
    server.addListener('connection', this.connectionHandler);
    server.on('listening', () => {
      log?.info(`${this.clientId} -- server is listening`);
    });
  }

  connectionHandler = (sock: Socket) => {
    log?.info(`${this.clientId} -- new incoming uds connection`);
    let session: Session<UdsConnection> | undefined = undefined;
    const conn = new UdsConnection(sock);
    conn.onData((data) => {
      const parsed = this.parseMsg(data);
      if (!parsed) return;
      if (!session) {
        session = this.onConnect(conn, parsed.from);
      }

      this.handleMsg(parsed);
    });

    const cleanup = () => this.onDisconnect(conn, session?.connectedTo);
    sock.on('close', () => {
      log?.info(
        `${this.clientId} -- uds to ${
          session?.connectedTo ?? 'unknown'
        } disconnected`,
      );
      cleanup();
    });

    sock.on('error', (err) => {
      log?.warn(
        `${this.clientId} -- uds to ${
          session?.connectedTo ?? 'unknown'
        } got an error: ${err}`,
      );
      cleanup();
    });
  };

  async createNewConnection(to: string): Promise<void> {
    const err = `${this.clientId} -- failed to send msg to ${to}, client probably dropped`;
    log?.warn(err);
    return;
  }

  async close() {
    this.server.removeListener('connection', this.connectionHandler);
    super.close();
  }
}
