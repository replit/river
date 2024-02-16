import { Transport, TransportClientId } from '../..';
import { Codec, NaiveJsonCodec } from '../../../codec';
import { createConnection } from 'node:net';
import { StreamConnection } from '../stdio/connection';
import { log } from '../../../logging';
import { MessageFramer } from '../../transforms/messageFraming';

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
    const sock = createConnection(this.path);
    const conn = new StreamConnection(sock);
    this.onConnect(conn, to);
    // conn.onData((data) => this.handleMsg(this.parseMsg(data)));
    const framedMessageStream = MessageFramer.createFramedStream();
    sock.pipe(framedMessageStream).on('data', (data) => {
      this.handleMsg(this.parseMsg(data));
    });
    const cleanup = () => this.onDisconnect(conn, to);

    sock.on('close', cleanup);
    sock.on('error', (err) => {
      log?.warn(
        `${this.clientId} -- socket error in connection to ${to}: ${err}`,
      );
      cleanup();
    });
  }
}
