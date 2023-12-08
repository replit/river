import { Codec } from '../../../codec';
import { NaiveJsonCodec } from '../../../codec/json';
import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { Connection, Transport } from '../../transport';
import readline from 'readline';

const newlineBuff = new TextEncoder().encode('\n');

export class StdioConnection extends Connection {
  output: NodeJS.WritableStream;

  constructor(
    transport: Transport<StdioConnection>,
    connectedTo: TransportClientId,
    output: NodeJS.WritableStream,
  ) {
    super(transport, connectedTo);
    this.output = output;
  }

  send(payload: Uint8Array) {
    const out = new Uint8Array(payload.length + newlineBuff.length);
    out.set(payload, 0);
    out.set(newlineBuff, payload.length);
    return this.output.write(out);
  }

  async close() {
    this.transport.onDisconnect(this);
    this.output.end();
  }
}

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
export class StdioTransport extends Transport<StdioConnection> {
  clientId: TransportClientId;
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
    this.clientId = clientId;
    this.input = input;
    this.output = output;
    this.setupConnectionStatusListeners();
  }

  setupConnectionStatusListeners(): void {
    let conn: StdioConnection | undefined = undefined;
    const rl = readline.createInterface({
      input: this.input,
    });

    const encoder = new TextEncoder();
    rl.on('line', (msg) => {
      const parsedMsg = this.parseMsg(encoder.encode(msg));
      if (parsedMsg && !this.connections.has(parsedMsg.from)) {
        conn = new StdioConnection(this, parsedMsg.from, this.output);
        this.onConnect(conn);
      }

      this.handleMsg(parsedMsg);
    });

    rl.on('close', () => {
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
    const conn = new StdioConnection(this, to, this.output);
    this.onConnect(conn);
  }
}
