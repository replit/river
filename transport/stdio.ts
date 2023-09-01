import { NaiveJsonCodec } from "../codec/json";
import { Codec } from "../codec/types";
import { Transport, TransportClientId, TransportMessage } from "./types";
import readline from "readline";

export class StdioTransport extends Transport {
  constructor(clientId: TransportClientId) {
    super(NaiveJsonCodec, clientId);
    const { stdin, stdout } = process;
    const rl = readline.createInterface({
      input: stdin,
      output: stdout,
    });

    rl.on("line", this.onMessage);
  }

  send(msg: TransportMessage): string {
    const id = msg.id;
    process.stdout.write(this.codec.toStringBuf(msg));
    return id;
  }

  async close() {}
}
