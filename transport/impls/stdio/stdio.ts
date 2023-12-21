import { Codec } from '../../../codec';
import { NaiveJsonCodec } from '../../../codec/json';
import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { createDelimitedStream } from '../../transforms/delim';
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

    const delimStream = createDelimitedStream();
    this.input = input.pipe(delimStream);
    this.output = output;

    let conn: StreamConnection | undefined = undefined;
    this.input.on('data', (msg) => {
      const parsedMsg = this.parseMsg(msg);
      if (parsedMsg && !this.connections.has(parsedMsg.from)) {
        conn = new StreamConnection(this, parsedMsg.from, this.output);
        this.onConnect(conn);
      }

      this.handleMsg(parsedMsg);
    });

    const cleanup = () => {
      delimStream.destroy();
      if (conn) {
        this.onDisconnect(conn);
      }
    };

    this.input.on('close', cleanup);
    this.input.on('error', (err) => {
      log?.warn(
        `${this.clientId} -- stdio error in connection to ${
          conn?.connectedTo ?? 'unknown'
        }: ${err}`,
      );
      cleanup();
    });
  }

  async createNewConnection(to: TransportClientId) {
    if (this.state === 'destroyed') {
      throw new Error('cant reopen a destroyed connection');
    }

    log?.info(`${this.clientId} -- establishing a new stream to ${to}`);
    const conn = new StreamConnection(this, to, this.output);
    this.onConnect(conn);
  }
}
