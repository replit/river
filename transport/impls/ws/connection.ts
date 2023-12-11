import { TransportClientId } from '../../message';
import { Connection, Transport } from '../../transport';
import WebSocket from 'isomorphic-ws';

export class WebSocketConnection extends Connection {
  ws: WebSocket;

  constructor(
    transport: Transport<WebSocketConnection>,
    connectedTo: TransportClientId,
    ws: WebSocket,
  ) {
    super(transport, connectedTo);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    // take over the onmessage for this websocket
    this.ws.onmessage = (msg) => transport.onMessage(msg.data as Uint8Array);
  }

  send(payload: Uint8Array) {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(payload);
      return true;
    } else {
      return false;
    }
  }

  async close() {
    this.ws.close();
  }
}
