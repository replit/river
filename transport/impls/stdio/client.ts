import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { ClientTransport, TransportOptions } from '../../transport';
import { StreamConnection } from './connection';

/**
 * A client-side transport implementation that uses standard input and output streams.
 * Will eagerly connect as soon as it's initialized.
 * @extends Transport
 */
export class StdioClientTransport extends ClientTransport<StreamConnection> {
  input: NodeJS.ReadableStream = process.stdin;
  output: NodeJS.WritableStream = process.stdout;
  serverId: TransportClientId;

  /**
   * Constructs a new StdioClientTransport instance.
   * @param clientId - The ID of the client associated with this transport.
   * @param input - The readable stream to use as input. Defaults to process.stdin.
   * @param output - The writable stream to use as output. Defaults to process.stdout.
   */
  constructor(
    clientId: TransportClientId,
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
    serverId: TransportClientId,
    providedOptions?: Partial<TransportOptions>,
  ) {
    super(clientId, providedOptions);
    this.input = input;
    this.output = output;
    this.serverId = serverId;
    this.connect(serverId);
  }

  async createNewOutgoingConnection(to: TransportClientId) {
    log?.info(`${this.clientId} -- establishing a new stream to ${to}`);
    const conn = new StreamConnection(this.input, this.output);
    conn.addDataListener(this.receiveWithBootSequence(conn));
    const cleanup = () => {
      this.onDisconnect(conn, to);
      this.connect(to);
    };

    this.input.addListener('close', cleanup);
    this.output.addListener('close', cleanup);
    return conn;
  }
}
