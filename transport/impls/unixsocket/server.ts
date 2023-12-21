import { Transport, TransportClientId } from '../..';
import { Codec, NaiveJsonCodec } from '../../../codec';
import { log } from '../../../logging';
import { createDelimitedStream } from '../../transforms/delim';
import { createServer, type Server } from 'node:net';
import { StreamConnection } from '../stdio/connection';

interface Options {
  codec: Codec;
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
};

export class UnixDomainSocketServerTransport extends Transport<StreamConnection> {
  path: string;
  server: Server;

  constructor(
    socketPath: string,
    clientId: TransportClientId,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);
    this.path = socketPath;
    this.server = createServer((sock) => {
      let conn: StreamConnection | undefined = undefined;

      sock.pipe(createDelimitedStream()).on('data', (data) => {
        const parsedMsg = this.parseMsg(data);
        if (!parsedMsg) {
          return;
        }

        if (!conn) {
          conn = new StreamConnection(this, parsedMsg.from, sock);
          this.onConnect(conn);
        }

        this.handleMsg(parsedMsg);
      });

      sock.on('close', () => {
        if (conn) {
          this.onDisconnect(conn);
        }
      });

      sock.on('error', (err) => {
        log?.warn(
          `${this.clientId} -- socket error in connection to ${
            conn?.connectedTo ?? 'unknown'
          }: ${err}`,
        );
      });
    });

    // there can be multiple transports on the same socket path
    this.server.listen({ path: this.path }, () => {
      log?.info(`${this.clientId} -- server is listening`);
    });
  }

  async createNewConnection(to: string): Promise<void> {
    const err = `${this.clientId} -- failed to send msg to ${to}, client probably dropped`;
    log?.warn(err);
    return;
  }

  async close() {
    super.close();
    this.server.close();
  }
}
