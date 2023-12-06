import { TransportClientId } from '../../message';
import { Connection, Transport } from '../../transport';
import type IsomorphicWebSocket from 'isomorphic-ws';

export class WebSocketConnection<
  Ws extends WebSocket | IsomorphicWebSocket,
> extends Connection {
  ws: Ws;

  constructor(
    transport: Transport<WebSocketConnection<Ws>>,
    connectedTo: TransportClientId,
    ws: Ws,
  ) {
    super(transport, connectedTo);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (
      msg: MessageEvent<any> | IsomorphicWebSocket.MessageEvent,
    ) => this.onMessage(msg.data as Uint8Array);
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
