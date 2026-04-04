# @effectionx/websocket

WebSocket client with stream-based message handling and automatic cleanup.

## Installation

```
npm install @effectionx/websocket
```

## API

### `useWebSocket(url: string | (() => WebSocket)): Operation<WebSocketResource>`

Opens a WebSocket connection. The operation doesn't resolve until the
connection successfully opens. Accepts a URL string or a factory function
(useful for Node.js <= 20 without native WebSocket).

### `WebSocketResource`

Extends `Stream` and provides:

- `send(data: WebSocketData): void` — Send data.
- `binaryType`, `bufferedAmount`, `extensions`, `protocol`, `readyState`,
  `url` — Standard WebSocket properties.
- Auto-closes when scope exits (no explicit close method needed).

## Usage

```ts
import { each } from "effection";
import { useWebSocket } from "@effectionx/websocket";

let socket = yield* useWebSocket("ws://example.org");
socket.send("Hello World");

for (let message of yield* each(socket)) {
  console.log("Message from server", message);
  yield* each.next();
}
```
