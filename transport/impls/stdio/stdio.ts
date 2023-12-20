import { Codec } from '../../../codec';
import { NaiveJsonCodec } from '../../../codec/json';
import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { DelimiterParser } from '../../transforms/delim';
import { Transport } from '../../transport';
import { StreamConnection } from './connection';

interface Options {
  codec: Codec;
  delim: Buffer;
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
  delim: Buffer.from('\n'),
};

/**
 * A transport implementation that uses standard input and output streams.
 * @extends Transport
 */
export class StdioTransport extends Transport<StreamConnection> {
  input: NodeJS.ReadableStream = process.stdin;
  output: NodeJS.WritableStream = process.stdout;
  delim: Buffer;

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
    this.delim = options.delim;
    this.input = input.pipe(new DelimiterParser({ delimiter: options.delim }));
    this.output = output;
    this.setupConnectionStatusListeners();
  }

  setupConnectionStatusListeners(): void {
    let conn: StreamConnection | undefined = undefined;

    this.input.on('data', (msg) => {
      const parsedMsg = this.parseMsg(msg);
      if (parsedMsg && !this.connections.has(parsedMsg.from)) {
        conn = new StreamConnection(
          this,
          parsedMsg.from,
          this.output,
          this.delim,
        );
        this.onConnect(conn);
      }

      this.handleMsg(parsedMsg);
    });

    this.input.on('close', () => {
      if (conn) {
        this.onDisconnect(conn);
      }
    });
  }

  async createNewConnection(to: TransportClientId) {
    if (this.state === 'destroyed') {
      throw new Error('cant reopen a destroyed connection');
    }

    log?.info(`${this.clientId} -- establishing a new stream to ${to}`);
    const conn = new StreamConnection(this, to, this.output, this.delim);
    this.onConnect(conn);
  }
}
