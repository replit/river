import { NaiveJsonCodec } from '../../codec/json';
import { OpaqueTransportMessage, TransportClientId } from '../message';
import { Transport } from '../types';
import readline from 'readline';

export class StdioTransport extends Transport {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;

  constructor(
    clientId: TransportClientId,
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ) {
    super(NaiveJsonCodec, clientId);
    this.input = input;
    this.output = output;
    const rl = readline.createInterface({
      input: this.input,
    });

    rl.on('line', (msg) => this.onMessage(msg));
  }

  send(msg: OpaqueTransportMessage): string {
    const id = msg.id;
    this.output.write(this.codec.toStringBuf(msg) + '\n');
    return id;
  }

  async close() {}
}
