import { Connection, Transport, TransportClientId } from '../..';
import { Delimiter } from '../../transforms/delim';

export class StreamConnection extends Connection {
  output: NodeJS.WritableStream;

  constructor(
    transport: Transport<StreamConnection>,
    connectedTo: TransportClientId,
    output: NodeJS.WritableStream,
  ) {
    super(transport, connectedTo);
    this.output = output;
  }

  send(payload: Uint8Array) {
    if (!this.output.writable) {
      return false;
    }

    return this.output.write(Delimiter.writeDelimited(payload));
  }

  async close() {
    this.output.end();
  }
}
