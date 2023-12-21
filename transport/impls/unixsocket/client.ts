import { Transport, TransportClientId } from '../..';
import { Codec, NaiveJsonCodec } from '../../../codec';
import { createDelimitedStream } from '../../transforms/delim';
import { createConnection } from 'node:net';
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

  // lazily create connection on first send to avoid cases
  // where we create client and server transports at the same time
  // but the server hasn't created the socket file yet
  async createNewConnection(to: string): Promise<void> {
    const oldConnection = this.connections.get(to);
    if (oldConnection) {
      oldConnection.close();
    }

    const sock = createConnection(this.path);
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
