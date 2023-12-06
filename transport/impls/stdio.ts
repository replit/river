import { Codec } from '../../codec';
import { NaiveJsonCodec } from '../../codec/json';
import { OpaqueTransportMessage, TransportClientId } from '../message';
import { Transport } from '../types';
import readline from 'readline';

interface Options {
  codec: Codec;
}

const defaultOptions: Options = {
  codec: NaiveJsonCodec,
};

const newlineBuff = new TextEncoder().encode('\n');

/**
 * A transport implementation that uses standard input and output streams.
 * @extends Transport
 */
export class StdioTransport extends Transport {
  /**
   * The readable stream to use as input.
   */
  input: NodeJS.ReadableStream;
  /**
   * The writable stream to use as output.
   */
  output: NodeJS.WritableStream;

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
    const rl = readline.createInterface({
      input: this.input,
    });

    const encoder = new TextEncoder();
    rl.on('line', (msg) => this.onMessage(encoder.encode(msg)));
  }

  /**
   * Sends a message over the transport.
   * @param msg - The message to send.
   * @returns The ID of the sent message.
   */
  send(msg: OpaqueTransportMessage): string {
    const id = msg.id;
    const payload = this.codec.toBuffer(msg);

    const out = new Uint8Array(payload.length + newlineBuff.length);
    out.set(payload, 0);
    out.set(newlineBuff, payload.length);
    this.output.write(out);
    return id;
  }

  /**
   * Closes the transport.
   */
  async close() {
    this.output.end();
  }
}
