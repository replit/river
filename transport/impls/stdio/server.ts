import { TransportClientId } from '../../message';
import { ServerTransport, TransportOptions } from '../../transport';
import { StreamConnection } from './connection';

/**
 * A server-side transport implementation that uses standard input and output streams.
 * This will sit idle until a client connects.
 * @extends Transport
 */
export class StdioServerTransport extends ServerTransport<StreamConnection> {
  input: NodeJS.ReadableStream = process.stdin;
  output: NodeJS.WritableStream = process.stdout;

  /**
   * Constructs a new StdioServerTransport instance.
   * @param clientId - The ID of the client associated with this transport.
   * @param input - The readable stream to use as input. Defaults to process.stdin.
   * @param output - The writable stream to use as output. Defaults to process.stdout.
   */
  constructor(
    clientId: TransportClientId,
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
    providedOptions?: Partial<TransportOptions>,
  ) {
    super(clientId, providedOptions);
    this.input = input;
    this.output = output;
    const conn = new StreamConnection(this.input, this.output);
    this.handleConnection(conn);
  }
}
