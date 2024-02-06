import { Transport, TransportClientId } from '../..';
import { Codec, NaiveJsonCodec } from '../../../codec';
import { MessageFramer } from '../../transforms/messageFraming';
import { createConnection } from 'node:net';
import { StreamConnection } from '../stdio/connection';
import { log } from '../../../logging';

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
    const framedMessageStream = MessageFramer.createFramedStream();
    sock.pipe(framedMessageStream).on('data', (data) => {
      const parsedMsg = this.parseMsg(data);
      if (parsedMsg) {
        this.handleMsg(parsedMsg);
      }
    });

    const cleanup = () => {
      framedMessageStream.destroy();
      if (conn) {
        this.onDisconnect(conn);
      }
    };

    sock.on('close', cleanup);
    sock.on('error', (err) => {
      log?.warn(
        `${this.clientId} -- socket error in connection to ${
          conn?.connectedTo ?? 'unknown'
        }: ${err}`,
      );
      cleanup();
    });

    this.onConnect(conn);
  }
}
