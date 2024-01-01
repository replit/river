# river - Streaming Remote Procedure Calls

It's like tRPC/gRPC but with

- JSON Schema Support + run-time schema validation
- full-duplex streaming
- service multiplexing
- result types and error handling
- snappy DX (no code-generation)
- over any transport (WebSockets, stdio, Unix Domain Socket out of the box)

## Installation

To use River, you must be on least Typescript 5 with `"moduleResolution": "bundler"`.

```bash
npm i @replit/river @sinclair/typebox

# if you plan on using WebSocket for transport, also install
npm i ws isomorphic-ws
```

## Writing Services

### Concepts

- Router: a collection of services, namespaced by service name.
- Service: a collection of procedures with shared state.
- Procedure: a single procedure. A procedure declares its type, an input message type, an output message type, optionally an error type, and the associated handler. Valid types are:
  - `rpc` whose handler has a signature of `Input -> Result<Output, Error>`.
  - `upload` whose handler has a signature of `AsyncIterableIterator<Input> -> Result<Output, Error>`.
  - `subscription` whose handler has a signature of `Input -> Pushable<Result<Output, Error>>`.
  - `stream` whose handler has a signature of `AsyncIterableIterator<Input> -> Pushable<Result<Output, Error>>`.
- Transport: manages the lifecycle (creation/deletion) of connections and multiplexing read/writes from clients. Both the client and the server must be passed in a subclass of `Transport` to work.
- Codec: encodes messages between clients/servers before the transport sends it across the wire.

### A basic router

First, we create a service using the `ServiceBuilder`

```ts
import { ServiceBuilder, Ok, buildServiceDefs } from '@replit/river';
import { Type } from '@sinclair/typebox';

export const ExampleServiceConstructor = () =>
  ServiceBuilder.create('example')
    .initialState({
      count: 0,
    })
    .defineProcedure('add', {
      type: 'rpc',
      input: Type.Object({ n: Type.Number() }),
      output: Type.Object({ result: Type.Number() }),
      errors: Type.Never(),
      async handler(ctx, { n }) {
        ctx.state.count += n;
        return Ok({ result: ctx.state.count });
      },
    })
    .finalize();

// expore a listing of all the services that we have
export const serviceDefs = buildServiceDefs([ExampleServiceConstructor()]);
```

Then, we create the server

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

const websocketUrl = `wss://localhost:3000`;
const transport = new WebSocketClientTransport(
  async () => new WebSocket(websocketUrl),
  'my-client-id',
  'SERVER',
);

const client = createClient<ServiceSurface>(transport, 'SERVER');

// we get full type safety on `client`
// client.<service name>.<procedure name>.<procedure type>()
// e.g.
const result = await client.example.add.rpc({ n: 3 });
if (result.ok) {
  const msg = result.payload;
  console.log(msg.result); // 0 + 3 = 3
}
```

To add logging,

```ts
import { bindLogger, setLevel } from '@replit/river/logging';

bindLogger(console.log);
setLevel('info');
```

### Further examples

We've also provided an end-to-end testing environment using Next.js, and a simple backend connected
with the WebSocket transport that you can [play with on Replit](https://replit.com/@jzhao-replit/riverbed).

You can find more service examples in the [E2E test fixtures](https://github.com/replit/river/blob/main/__tests__/fixtures/services.ts)

## Developing

[![Run on Repl.it](https://replit.com/badge/github/replit/river)](https://replit.com/new/github/replit/river)

- `npm i` -- install dependencies
- `npm run check` -- lint
- `npm run format` -- format
- `npm run test` -- run tests
- `npm run publish` -- cut a new release (should bump version in package.json first)
