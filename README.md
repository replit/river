# River

River is a framework designed to create long-lived streaming Remote Procedure Calls (RPCs) with features tailored to modern web applications. By combining JSON Schema support, full-duplex streaming, service multiplexing, and transparent reconnect support.
River offers developers a solution for building scalable and resilient RPC services.

### Prerequisites

Before proceeding, ensure you have TypeScript 5 installed and configured appropriately:

1. **Install TypeScript 5**:
   - To install TypeScript globally, you can use npm (Node Package Manager). Open your terminal or command prompt and run the following command:
     ```bash
     npm install -g typescript@5
     ```
     This will install TypeScript version 5 globally on your system.

2. **Ensure `"moduleResolution": "bundler"` in tsconfig.json**:
   - Navigate to your TypeScript project directory in your terminal.
   - Open the `tsconfig.json` file of your project in a text editor.
   - Ensure that the `"moduleResolution"` property is set to `"bundler"` in the `compilerOptions` section:
     ```json
     {
       "compilerOptions": {
         "moduleResolution": "bundler",
         // Other compiler options...
       }
     }
     ```
     If the `"moduleResolution"` property does not exist, add the following to your config file. `"moduleResolution": "bundler"`. If it exists but is set to a different value, modify it to `"bundler"`.

3. Install River and Dependencies:

  To use River, install the required packages using npm:
  ```bash
    npm i @replit/river @sinclair/typebox
  ```
4. If you plan on using WebSocket for transport, also install
  ```bash
  npm i ws isomorphic-ws
  ```
These commands will install River, `@sinclair/typebox`, and optionally WebSocket dependencies (`ws` and `isomorphic-ws`) for transport if needed.

## Long-lived streaming remote procedure calls

River provides a framework for long-lived streaming Remote Procedure Calls (RPCs) in modern web applications, featuring advanced error handling and customizable retry policies to ensure seamless communication between clients and servers.

- **tRPC (Typed RPC)**: A TypeScript-first RPC framework emphasizing strong typing and code generation, offering automatic serialization, validation, and error handling for high-performance APIs in TypeScript projects.

- **gRPC (Google Remote Procedure Call)**: An open-source RPC framework utilizing HTTP/2 and Protocol Buffers for bi-directional streaming, load balancing, and authentication, commonly used in microservices architectures and distributed systems.

River provides a framework similar to tRPC and gRPC but with additional features:

- JSON Schema Support + run-time schema validation
- full-duplex streaming
- service multiplexing
- result types and error handling
- snappy DX (no code generation)
- transparent reconnect support for long-lived sessions
- over any transport (WebSockets and Unix Domain Socket out of the box)

For more information on the Protocol, refer to the [PROTOCOL.md](./PROTOCOL.md) document.

## Writing services

### Concepts

- Router: a collection of services, namespaced by service name.
- Service: a collection of procedures with a shared state.
- Procedure: a single procedure. A procedure declares its type, an input message type, an output message type, optionally an error type, and the associated handler. Valid types are:
  - `rpc` whose handler has a signature of `Input -> Result<Output, Error>`.
  - `upload` whose handler has a signature of `AsyncIterableIterator<Input> -> Result<Output, Error>`.
  - `subscription` whose handler has a signature of `Input -> Pushable<Result<Output, Error>>`.
  - `stream` whose handler has a signature of `AsyncIterableIterator<Input> -> Pushable<Result<Output, Error>>`.
- Transport: manages the lifecycle (creation/deletion) of connections and multiplexing read/writes from clients. Both the client and the server must be passed in a subclass of `Transport` to work.
  - Connection: the actual raw underlying transport connection
  - Session: a higher-level abstraction that operates over the span of potentially multiple transport-level connections
- Codec: encodes messages between clients/servers before transmitting them across the wire.

### A basic router

First, we create a service using the `ServiceBuilder`

```ts
import { ServiceBuilder, Ok, buildServiceDefs } from '@replit/river';
import { Type } from '@sinclair/typebox';

export const ExampleServiceConstructor = () =>
  ServiceBuilder.create('example')
    // initializer for shared state
    .initialState({
      count: 0,
    })
    .defineProcedure('add', {
      type: 'rpc',
      input: Type.Object({ n: Type.Number() }),
      output: Type.Object({ result: Type.Number() }),
      errors: Type.Never(),
      // note that a handler is unique per user RPC
      async handler(ctx, { n }) {
        // access and mutate shared state
        ctx.state.count += n;
        return Ok({ result: ctx.state.count });
      },
    })
    .finalize();

// expore a listing of all the services that we have
export const serviceDefs = buildServiceDefs([ExampleServiceConstructor()]);
```

Then, we create the server:

```ts
import http from 'http';
import { WebSocketServer } from 'ws';
import { WebSocketServerTransport } from '@replit/river/transport/ws/server';
import { createServer } from '@replit/river';

// start websocket server on port 3000
const httpServer = http.createServer();
const port = 3000;
const wss = new WebSocketServer({ server: httpServer });
const transport = new WebSocketServerTransport(wss, 'SERVER');

export const server = createServer(transport, serviceDefs);
export type ServiceSurface = typeof server;

httpServer.listen(port);
```

In another file for the client (to create a separate entrypoint),

```ts
import WebSocket from 'isomorphic-ws';
import { WebSocketClientTransport } from '@replit/river/transport/ws/client';
import { createClient } from '@replit/river';
import type ServiceSurface from './server';

const websocketUrl = `ws://localhost:3000`;
const transport = new WebSocketClientTransport(
  async () => new WebSocket(websocketUrl),
  'my-client-id',
);

const client = createClient<ServiceSurface>(
  transport,
  'SERVER', // transport id of the server in the previous step
  true, // whether to eagerly connect to the server on creation (optional argument)
);

// we get full type safety on `client`
// client.<service name>.<procedure name>.<procedure type>()
// e.g.
const result = await client.example.add.rpc({ n: 3 });
if (result.ok) {
  const msg = result.payload;
  console.log(msg.result); // 0 + 3 = 3
}
```

### Logging

To add logging,

```ts
import { bindLogger, setLevel } from '@replit/river/logging';

bindLogger(console.log);
setLevel('info');
```

### Connection status

River defines two types of reconnects:

1. **Transparent reconnects:** These occur when the connection is temporarily lost and reestablished without losing any messages. From the application's perspective, this process is seamless and does not disrupt ongoing operations.
2. **Hard reconnect:** This occurs when all server state is lost, requiring the client to reinitialize anything stateful (e.g. subscriptions).

You can listen for transparent reconnects via the `connectionStatus` events, but realistically, no applications should need to listen for this unless it is for debugging purposes. Hard reconnects are signaled via `sessionStatus` events.

If your application is stateful on either the server or the client, the service consumer _should_ wrap all the client-side setup with `transport.addEventListener('sessionStatus', (evt) => ...)` to do appropriate setup and teardown.

```ts
transport.addEventListener('connectionStatus', (evt) => {
  if (evt.status === 'connect') {
    // do something
  } else if (evt.status === 'disconnect') {
    // do something else
  }
});

transport.addEventListener('sessionStatus', (evt) => {
  if (evt.status === 'connect') {
    // do something
  } else if (evt.status === 'disconnect') {
    // do something else
  }
});
```

### Further examples

We've also provided an end-to-end testing environment using `Next.js`, and a simple backend connected with the WebSocket transport that you can [play with on Replit](https://replit.com/@jzhao-replit/riverbed).

You can find more service examples in the [E2E test fixtures](https://github.com/replit/river/blob/main/__tests__/fixtures/services.ts)

## Developing

[![Run on Repl.it](https://replit.com/badge/github/replit/river)](https://replit.com/new/github/replit/river)

- `npm i` -- install dependencies
- `npm run check` -- lint
- `npm run format` -- format
- `npm run test` -- run tests
- `npm run publish` -- cut a new release (should bump version in package.json first)
