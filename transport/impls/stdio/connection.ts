import { Connection, Transport, TransportClientId } from '../..';

export class StreamConnection extends Connection {
  output: NodeJS.WritableStream;
  delim: Buffer;

  constructor(
    transport: Transport<StreamConnection>,
    connectedTo: TransportClientId,
    output: NodeJS.WritableStream,
    delim: Buffer,
  ) {
    super(transport, connectedTo);
    this.output = output;
    this.delim = delim;
  }

  send(payload: Uint8Array) {
    if (!this.output.writable) {
      return false;
    }

    return this.output.write(Buffer.concat([payload, this.delim]));
  }

  async close() {
    this.output.end();
  }
}
