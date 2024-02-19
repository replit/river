import { Codec } from '../../../codec';
import { NaiveJsonCodec } from '../../../codec/json';
import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { Session } from '../../session';
import { Transport } from '../../transport';
import { StreamConnection } from './connection';

interface Options {
  codec: Codec;
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
};

/**
 * A transport implementation that uses standard input and output streams.
 * @extends Transport
 */
export class StdioTransport extends Transport<StreamConnection> {
  input: NodeJS.ReadableStream = process.stdin;
  output: NodeJS.WritableStream = process.stdout;

  /**
   * Constructs a new StdioTransport instance.
   * @param clientId - The ID of the client associated with this transport.
   * @param input - The readable stream to use as input. Defaults to process.stdin.
   * @param output - The writable stream to use as output. Defaults to process.stdout.
   */
  constructor(
    clientId: TransportClientId,
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
    providedOptions?: Partial<Options>,
  ) {
    const options = { ...defaultOptions, ...providedOptions };
    super(options.codec, clientId);

    this.input = input;
    this.output = output;
    this.setupConn(new StreamConnection(this.input, this.output));
  }

  setupConn(conn: StreamConnection, to?: TransportClientId) {
    let session: Session<StreamConnection> | undefined = undefined;

    const receiver = () => session?.connectedTo ?? 'unknown';
    conn.onData((data) => {
      const parsed = this.parseMsg(data);
      if (!parsed) return;
      if (!session && !this.connections.has(parsed.from)) {
        session = this.onConnect(conn, parsed.from);
      }

      this.handleMsg(parsed);
    });

    const cleanup = (session: Session<StreamConnection>) =>
      this.onDisconnect(conn, session.connectedTo);

    this.input.on('close', () => {
      if (!session) return;
      log?.info(
        `${this.clientId} -- stream conn (id: ${
          conn.id
        }) to ${receiver()} disconnected`,
      );
      cleanup(session);
    });

    this.input.on('error', (err) => {
      if (!session) return;
      log?.warn(
        `${this.clientId} -- error in stream connection (id: ${
          conn.id
        }) to ${receiver()}: ${err}`,
      );
      cleanup(session);
    });

    if (to) {
      session = this.onConnect(conn, to);
    }
  }

  async createNewConnection(to: TransportClientId) {
    if (this.state === 'destroyed') {
      throw new Error('cant reopen a destroyed connection');
    }

    log?.info(`${this.clientId} -- establishing a new stream to ${to}`);

    // wait 250 ms then open
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.setupConn(new StreamConnection(this.input, this.output), to);
  }
}
