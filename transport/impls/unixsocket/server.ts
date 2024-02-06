import { Transport, TransportClientId } from '../..';
import { Codec, NaiveJsonCodec } from '../../../codec';
import { log } from '../../../logging';
import { MessageFramer } from '../../transforms/messageFraming';
import { type Server, type Socket } from 'node:net';
import { StreamConnection } from '../stdio/connection';

interface Options {
  codec: Codec;
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
};

export class UnixDomainSocketServerTransport extends Transport<StreamConnection> {
  server: Server;

  constructor(
    server: Server,
    clientId: TransportClientId,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);
    this.server = server;
    server.addListener('connection', this.connectionListener);
    server.on('listening', () => {
      log?.info(`${this.clientId} -- server is listening`);
    });
  }

  connectionListener = (sock: Socket) => {
    let conn: StreamConnection | undefined = undefined;

    const framedMessageStream = MessageFramer.createFramedStream();
    sock.pipe(framedMessageStream).on('data', (data) => {
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
  };

  async createNewConnection(to: string): Promise<void> {
    const err = `${this.clientId} -- failed to send msg to ${to}, client probably dropped`;
    log?.warn(err);
    return;
  }

  async close() {
    this.server.removeListener('connection', this.connectionListener);
    super.close();
  }
}
