import { Transport, TransportClientId } from '../..';
import { Codec, NaiveJsonCodec } from '../../../codec';
import { DelimiterParser } from '../../transforms/delim';
import { createConnection } from 'net';
import { StreamConnection } from '../stdio/connection';

interface Options {
  codec: Codec;
  delim: Buffer;
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
  delim: Buffer.from('\n'),
};

export class UnixDomainSocketClientTransport extends Transport<StreamConnection> {
  path: string;
  serverId: TransportClientId;
  delim: Buffer;

  constructor(
    socketPath: string,
    clientId: string,
    serverId: TransportClientId,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);
    this.delim = options.delim;
    this.path = socketPath;
    this.serverId = serverId;
  }

  setupConnectionStatusListeners(): void {
    this.createNewConnection(this.serverId);
  }

  async createNewConnection(to: string): Promise<void> {
    const oldConnection = this.connections.get(to);
    if (oldConnection) {
      oldConnection.close();
    }

    const sock = createConnection({ path: this.path });
    const conn = new StreamConnection(this, to, sock, this.delim);
    sock
      .pipe(new DelimiterParser({ delimiter: this.delim }))
      .on('data', (data) => {
        const parsedMsg = this.parseMsg(data);
        if (parsedMsg) {
          this.handleMsg(parsedMsg);
        }
      });

    sock.on('close', () => {
      if (conn) {
        this.onDisconnect(conn);
      }
    });

    this.onConnect(conn);
  }
}
