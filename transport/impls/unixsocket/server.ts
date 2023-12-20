import { Transport, TransportClientId } from '../..';
import { Codec, NaiveJsonCodec } from '../../../codec';
import { log } from '../../../logging';
import { DelimiterParser } from '../../transforms/delim';
import { createServer, type Server } from 'net';
import { StreamConnection } from '../stdio/connection';

interface Options {
  codec: Codec;
  delim: Buffer;
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
  delim: Buffer.from('\n'),
};

export class UnixDomainSocketServerTransport extends Transport<StreamConnection> {
  path: string;
  server: Server;
  delim: Buffer;

  constructor(
    socketPath: string,
    clientId: TransportClientId,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);
    this.delim = options.delim;
    this.path = socketPath;
    this.server = createServer((sock) => {
      let conn: StreamConnection | undefined = undefined;

      sock
        .pipe(new DelimiterParser({ delimiter: this.delim }))
        .on('data', (data) => {
          const parsedMsg = this.parseMsg(data);
          if (!parsedMsg) {
            return;
          }

          if (!conn) {
            conn = new StreamConnection(this, parsedMsg.from, sock, this.delim);
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
          `${this.clientId} -- socket error from client ${
            conn?.connectedTo ?? 'unknown'
          }: ${err}`,
        );
      });
    });
    this.setupConnectionStatusListeners();
  }

  setupConnectionStatusListeners(): void {
    // there can be multiple transports on the same socket path
    this.server.listen({ path: this.path, exclusive: false }, () => {
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
