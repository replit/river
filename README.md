# River

⚠️ Not production ready, while Replit is using parts of River in production, we are still going through rapid breaking changes. First production ready version will be `1.x.x` ⚠️

River allows multiple clients to connect to and make remote procedure calls to a remote server as if they were local procedures.

## Long-lived streaming remote procedure calls

River provides a framework for long-lived streaming Remote Procedure Calls (RPCs) in modern web applications, featuring advanced error handling and customizable retry policies to ensure seamless communication between clients and servers.

River provides a framework similar to [tRPC](https://trpc.io/) and [gRPC](https://grpc.io/) but with additional features:

- JSON Schema Support + run-time schema validation
- full-duplex streaming
- service multiplexing
- result types and error handling
- snappy DX (no code generation)
- transparent reconnect support for long-lived sessions
- over any transport (WebSockets and Unix Domain Socket out of the box)

See [PROTOCOL.md](./PROTOCOL.md) for more information on the protocol.

### Prerequisites

Before proceeding, ensure you have TypeScript 5 installed and configured appropriately:

1. **Ensure your `tsconfig.json` is configured correctly**:

   You must verify that:

   - `compilerOptions.moduleResolution` is set to `"bundler"`
   - `compilerOptions.strictFunctionTypes` is set to `true`
   - `compilerOptions.strictNullChecks` is set to `true`

   or, preferably, that:

   - `compilerOptions.moduleResolution` is set to `"bundler"`
   - `compilerOptions.strict` is set to `true`

   Like so:

   ```jsonc
   {
     "compilerOptions": {
       "moduleResolution": "bundler",
       "strict": true
       // Other compiler options...
     }
   }
   ```

   If these options already exist in your `tsconfig.json` and don't match what is shown above, modify them. River is designed for `"strict": true`, but technically only `strictFunctionTypes` and `strictNullChecks` being set to `true` is required. Failing to set these will cause unresolvable type errors when defining services.

2. Install River and Dependencies:

   To use River, install the required packages using npm:

   ```bash
   npm i @replit/river @sinclair/typebox
   ```

## Writing services

### Concepts

- Router: a collection of services, namespaced by service name.
- Service: a collection of procedures with a shared state.
- Procedure: a single procedure. A procedure declares its type, a request data type, a response data type, optionally a response error type, and the associated handler. Valid types are:
  - `rpc`, single request, single response
  - `upload`, multiple requests, single response
  - `subscription`, single request, multiple responses
  - `stream`, multiple requests, multiple response
- Transport: manages the lifecycle (creation/deletion) of connections and multiplexing read/writes from clients. Both the client and the server must be passed in a subclass of `Transport` to work.
  - Connection: the actual raw underlying transport connection
  - Session: a higher-level abstraction that operates over the span of potentially multiple transport-level connections
- Codec: encodes messages between clients/servers before the transport sends it across the wire.

### A basic router

First, we create a service using `ServiceSchema`:

```ts
import { ServiceSchema, Procedure, Ok } from '@replit/river';
import { Type } from '@sinclair/typebox';

export const ExampleService = ServiceSchema.define(
  // configuration
  {
    // initializer for shared state
    initializeState: () => ({ count: 0 }),
  },
  // procedures
  {
    add: Procedure.rpc({
      requestInit: Type.Object({ n: Type.Number() }),
      responseData: Type.Object({ result: Type.Number() }),
      requestErrors: Type.Never(),
      // note that a handler is unique per user RPC
      async handler({ ctx, reqInit: { n } }) {
        // access and mutate shared state
        ctx.state.count += n;
        return Ok({ result: ctx.state.count });
      },
    }),
  },
);
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

export const server = createServer(transport, {
  example: ExampleService,
});

export type ServiceSurface = typeof server;

httpServer.listen(port);
```

In another file for the client (to create a separate entrypoint),

```ts
import { WebSocketClientTransport } from '@replit/river/transport/ws/client';
import { createClient } from '@replit/river';
import { WebSocket } from 'ws';

const transport = new WebSocketClientTransport(
  async () => new WebSocket('ws://localhost:3000'),
  'my-client-id',
);

const client = createClient(
  transport,
  'SERVER', // transport id of the server in the previous step
  { eagerlyConnect: true }, // whether to eagerly connect to the server on creation (optional argument)
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

To add logging, you can bind a logging function to a transport.

```ts
import { coloredStringLogger } from '@replit/river/logging';

const transport = new WebSocketClientTransport(
  async () => new WebSocket('ws://localhost:3000'),
  'my-client-id',
);

transport.bindLogger(console.log);
// or
transport.bindLogger(coloredStringLogger);
```

You can define your own logging functions that satisfy the `LogFn` type.

### Connection status

River defines two types of reconnects:

1. **Transparent reconnects:** These occur when the connection is temporarily lost and reestablished without losing any messages. From the application's perspective, this process is seamless and does not disrupt ongoing operations.
2. **Hard reconnect:** This occurs when all server state is lost, requiring the client to reinitialize anything stateful (e.g. subscriptions).

Hard reconnects are signaled via `sessionStatus` events.

If your application is stateful on either the server or the client, the service consumer _should_ wrap all the client-side setup with `transport.addEventListener('sessionStatus', (evt) => ...)` to do appropriate setup and teardown.

```ts
transport.addEventListener('sessionStatus', (evt) => {
  if (evt.status === 'created') {
    // do something
  } else if (evt.status === 'closing') {
    // do other things
  } else if (evt.status === 'closed') {
    // note that evt.session only has id + to
    // this is useful for doing things like creating a new session if
    // a session just got yanked
  }
});

// or, listen for specific session states
transport.addEventListener('sessionTransition', (evt) => {
  if (evt.state === SessionState.Connected) {
    // switch on various transition states
  } else if (evt.state === SessionState.NoConnection) {
    // do something
  }
});
```

### Custom Handshake

River allows you to extend the protocol-level handshake so you can add additional logic to
validate incoming connections.

You can do this by passing extra options to `createClient` and `createServer` and extending the `ParsedMetadata` interface:

```ts
declare module '@replit/river' {
  interface ParsedMetadata {
    userId: number;
  }
}

const schema = Type.Object({ token: Type.String() });
createClient<typeof services>(new MockClientTransport('client'), 'SERVER', {
  eagerlyConnect: false,
  handshakeOptions: createClientHandshakeOptions(schema, async () => ({
    // the type of this function is
    // () => Static<typeof schema> | Promise<Static<typeof schema>>
    token: '123',
  })),
});

createServer(new MockServerTransport('SERVER'), services, {
  handshakeOptions: createServerHandshakeOptions(
    schema,
    (metadata, previousMetadata) => {
      // the type of this function is
      // (metadata: Static<typeof<schema>, previousMetadata?: ParsedMetadata) =>
      //   | false | Promise<false> (if you reject it)
      //   | ParsedMetadata | Promise<ParsedMetadata> (if you allow it)
      // next time a connection happens on the same session, previousMetadata will
      // be populated with the last returned value
    },
  ),
});
```

You can then access the `ParsedMetadata` in your procedure handlers:

```ts
async handler(ctx, ...args) {
  // this contains the parsed metadata
  console.log(ctx.metadata)
}
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
- `npm run release` -- cut a new release (should bump version in package.json first)

## Releasing

River uses an automated release process with [Release Drafter](https://github.com/release-drafter/release-drafter) for version management and NPM publishing.

### Automated Release Process (Recommended)

1. **Merge PRs to main** - Release Drafter automatically:

   - Updates the draft release notes with PR titles
   - You can view the draft at [GitHub Releases](../../releases)

2. **When ready to release, create a version bump PR**:

   - Create a PR that bumps the version in `package.json` and `package-lock.json`
   - Use semantic versioning:
     - `patch` - Bug fixes, small improvements (e.g., 0.208.4 → 0.208.5)
     - `minor` - New features, backwards compatible (e.g., 0.208.4 → 0.209.0)
     - `major` - Breaking changes (e.g., 0.208.4 → 1.0.0)
   - Merge the PR to main

3. **Publish the GitHub release**:

   - Go to [GitHub Releases](../../releases)
   - Find the draft release and click "Edit"
   - Update the tag to match your new version (e.g., `v0.209.0`)
   - Click "Publish release"

4. **Automation takes over**:
   - Publishing the release automatically triggers the "Build and Publish" workflow
   - The `river` package is published to NPM
