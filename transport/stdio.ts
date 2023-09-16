import { NaiveJsonCodec } from '../codec/json';
import { OpaqueTransportMessage, TransportClientId } from './message';
import { Transport } from './types';
import readline from 'readline';

export class StdioTransport extends Transport {
  constructor(clientId: TransportClientId) {
    super(NaiveJsonCodec, clientId);
    const { stdin, stdout } = process;
    const rl = readline.createInterface({
      input: stdin,
      output: stdout,
    });

    rl.on('line', (msg) => this.onMessage(msg));
  }

  send(msg: OpaqueTransportMessage): string {
    const id = msg.id;
    process.stdout.write(this.codec.toStringBuf(msg));
    return id;
  }

  async close() {}
}
