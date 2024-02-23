import { log } from '../../../logging';
import { TransportClientId } from '../../message';
import { Session } from '../../session';
import { Transport, TransportOptions } from '../../transport';
import { StreamConnection } from './connection';

/**
 * A server-side transport implementation that uses standard input and output streams.
 * This will sit idle until a client connects.
 * @extends Transport
 */
export class StdioServerTransport extends Transport<StreamConnection> {
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

    let session: Session<StreamConnection> | undefined = undefined;
    const receiver = () => session?.connectedTo ?? 'unknown';

    const conn = new StreamConnection(this.input, this.output);
    conn.addDataListener((data) => {
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
          conn.debugId
        }) to ${receiver()} disconnected`,
      );
      cleanup(session);
    });

    this.input.on('error', (err) => {
      if (!session) return;
      log?.warn(
        `${this.clientId} -- error in stream connection (id: ${
          conn.debugId
        }) to ${receiver()}: ${err}`,
      );
      cleanup(session);
    });
  }

  async createNewOutgoingConnection(to: string): Promise<StreamConnection> {
    const err = `${this.clientId} -- failed to send msg to ${to}, client probably dropped`;
    log?.warn(err);
    throw new Error(err);
  }
}
