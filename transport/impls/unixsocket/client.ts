import { Transport, TransportClientId } from '../..';
import { Codec, NaiveJsonCodec } from '../../../codec';
import { createDelimitedStream } from '../../transforms/delim';
import { createConnection } from 'net';
import { StreamConnection } from '../stdio/connection';

interface Options {
  codec: Codec;
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
};

export class UnixDomainSocketClientTransport extends Transport<StreamConnection> {
  path: string;
  serverId: TransportClientId;

  constructor(
    socketPath: string,
    clientId: string,
    serverId: TransportClientId,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);
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
    const conn = new StreamConnection(this, to, sock);
    sock.pipe(createDelimitedStream()).on('data', (data) => {
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
