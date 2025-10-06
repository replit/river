# River

## Long-lived streaming remote procedure calls

River provides a framework for long-lived streaming Remote Procedure Calls (RPCs) in modern web applications, featuring advanced error handling and customizable retry policies to ensure seamless communication between clients and servers.

River provides a framework similar to [tRPC](https://trpc.io/) and [gRPC](https://grpc.io/) but with additional features:

- JSON Schema Support + run-time schema validation
- full-duplex streaming
- service multiplexing
- result types and error handling
- snappy DX (no code generation)
- transparent reconnect support for long-lived sessions
- over any transport (WebSockets out of the box)
- full OpenTelemetry integration (connections, sessions, procedure calls)

See [PROTOCOL.md](./PROTOCOL.md) for more information on the protocol.

### Prerequisites

Before proceeding, ensure you have TypeScript 5 installed and configured appropriately:

1. **Ensure your `tsconfig.json` is configured correctly**:

   You must verify that:

   - `compilerOptions.moduleResolution` is set to `"bundler"`
   - `compilerOptions.strict` is set to true (or at least `compilerOptions.strictFunctionTypes` and `compilerOptions.strictNullChecks`)

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

   If these options already exist in your `tsconfig.json` and don't match what is shown above, modify them. Failing to set these will cause unresolvable type errors when defining services.

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

First, we create a service:

```ts
import { createServiceSchema, Procedure, Ok } from '@replit/river';
import { Type } from '@sinclair/typebox';

const ServiceSchema = createServiceSchema();
export const ExampleService = ServiceSchema.define(
  // optional configuration parameter
  {
    // initializer for shared state
    initializeState: () => ({ count: 0 }),
  },
  // procedures
  {
    add: Procedure.rpc({
      // input type
      requestInit: Type.Object({ n: Type.Number() }),
      // response data type
      responseData: Type.Object({ result: Type.Number() }),
      // any error results (other than the uncaught) that this procedure can return
      responseError: Type.Never(),
      // note that a handler is unique per user
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

const services = {
  example: ExampleService,
};

export type ServiceSurface = typeof services;

const server = createServer(transport, services);

httpServer.listen(port);
```

In another file for the client (to create a separate entrypoint),

```ts
import { WebSocketClientTransport } from '@replit/river/transport/ws/client';
import { createClient } from '@replit/river';
import { WebSocket } from 'ws';
import type { ServiceSurface } from './server';
//     ^ type only import to avoid bundling the server!

const transport = new WebSocketClientTransport(
  async () => new WebSocket('ws://localhost:3000'),
  'my-client-id',
);

const client = createClient<ServiceSurface>(
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

### Error Handling

River uses a Result pattern for error handling. All procedure responses are wrapped in `Ok()` for success or `Err()` for errors:

```ts
import { Ok, Err } from '@replit/river';

// success
return Ok({ result: 42 });

// error
return Err({ code: 'INVALID_INPUT', message: 'Value must be positive' });
```

#### Custom Error Types

You can define custom error schemas for your procedures:

```ts
const MathService = ServiceSchema.define({
  divide: Procedure.rpc({
    requestInit: Type.Object({ a: Type.Number(), b: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    responseError: Type.Union([
      Type.Object({
        code: Type.Literal('DIVISION_BY_ZERO'),
        message: Type.String(),
        extras: Type.Object({ dividend: Type.Number() }),
      }),
      Type.Object({
        code: Type.Literal('INVALID_INPUT'),
        message: Type.String(),
      }),
    ]),
    async handler({ reqInit: { a, b } }) {
      if (b === 0) {
        return Err({
          code: 'DIVISION_BY_ZERO',
          message: 'Cannot divide by zero',
          extras: { dividend: a },
        });
      }

      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return Err({
          code: 'INVALID_INPUT',
          message: 'Inputs must be finite numbers',
        });
      }

      return Ok({ result: a / b });
    },
  }),
});
```

#### Uncaught Errors

When a procedure handler throws an uncaught error, River automatically handles it:

```ts
const ExampleService = ServiceSchema.define({
  maybeThrow: Procedure.rpc({
    requestInit: Type.Object({ shouldThrow: Type.Boolean() }),
    responseData: Type.Object({ result: Type.String() }),
    async handler({ reqInit: { shouldThrow } }) {
      if (shouldThrow) {
        throw new Error('Something went wrong!');
      }

      return Ok({ result: 'success' });
    },
  }),
});

// client will receive an error with code 'UNCAUGHT_ERROR'
const result = await client.example.maybeThrow.rpc({ shouldThrow: true });
if (!result.ok && result.payload.code === 'UNCAUGHT_ERROR') {
  console.log('Handler threw an error:', result.payload.message);
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

### Advanced Patterns

#### All Procedure Types

River supports four types of procedures, each with different message patterns:

##### RPC Procedures (1:1)

Single request, single response:

```ts
const ExampleService = ServiceSchema.define({
  add: Procedure.rpc({
    requestInit: Type.Object({ a: Type.Number(), b: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    async handler({ reqInit: { a, b } }) {
      return Ok({ result: a + b });
    },
  }),
});

// client usage
const result = await client.example.add.rpc({ a: 1, b: 2 });
if (result.ok) {
  console.log(result.payload.result); // 3
}
```

##### Upload Procedures (n:1)

Multiple requests, single response:

```ts
const ExampleService = ServiceSchema.define({
  sum: Procedure.upload({
    requestInit: Type.Object({ multiplier: Type.Number() }),
    requestData: Type.Object({ value: Type.Number() }),
    responseData: Type.Object({ total: Type.Number() }),
    responseError: Type.Object({
      code: Type.Literal('INVALID_INPUT'),
      message: Type.String(),
    }),
    async handler({ ctx, reqInit, reqReadable }) {
      let sum = 0;
      for await (const msg of reqReadable) {
        if (!msg.ok) {
          return ctx.cancel('client disconnected');
        }

        sum += msg.payload.value;
      }
      return Ok({ total: sum * reqInit.multiplier });
    },
  }),
});

// client usage
const { reqWritable, finalize } = client.example.sum.upload({ multiplier: 2 });
reqWritable.write({ value: 1 });
reqWritable.write({ value: 2 });
reqWritable.write({ value: 3 });

const result = await finalize();
if (result.ok) {
  console.log(result.payload.total); // 12 (6 * 2)
} else {
  console.error('Upload failed:', result.payload.message);
}
```

##### Subscription Procedures (1:n)

Single request, multiple responses:

```ts
const ExampleService = ServiceSchema.define(
  { initializeState: () => ({ count: 0 }) },
  {
    counter: Procedure.subscription({
      requestInit: Type.Object({ interval: Type.Number() }),
      responseData: Type.Object({ count: Type.Number() }),
      async handler({ ctx, reqInit, resWritable }) {
        const intervalId = setInterval(() => {
          ctx.state.count++;
          resWritable.write(Ok({ count: ctx.state.count }));
        }, reqInit.interval);

        ctx.signal.addEventListener('abort', () => {
          clearInterval(intervalId);
        });
      },
    }),
  },
);

// client usage
const { resReadable } = client.example.counter.subscribe({ interval: 1000 });
for await (const msg of resReadable) {
  if (msg.ok) {
    console.log('Count:', msg.payload.count);
  } else {
    console.error('Subscription error:', msg.payload.message);
    break; // exit on error for subscriptions
  }
}
```

##### Stream Procedures (n:n)

Multiple requests, multiple responses:

```ts
const ExampleService = ServiceSchema.define({
  echo: Procedure.stream({
    requestInit: Type.Object({ prefix: Type.String() }),
    requestData: Type.Object({ message: Type.String() }),
    responseData: Type.Object({ echo: Type.String() }),
    async handler({ reqInit, reqReadable, resWritable, ctx }) {
      for await (const msg of reqReadable) {
        if (!msg.ok) {
          return;
        }

        const { message } = msg.payload;
        resWritable.write(
          Ok({
            echo: `${reqInit.prefix}: ${message}`,
          }),
        );
      }

      // client ended their side, we can close ours
      resWritable.close();
    },
  }),
});

// client usage
const { reqWritable, resReadable } = client.example.echo.stream({
  prefix: 'Server',
});

// send messages
reqWritable.write({ message: 'Hello' });
reqWritable.write({ message: 'World' });
reqWritable.close();

// read responses
for await (const msg of resReadable) {
  if (msg.ok) {
    console.log(msg.payload.echo); // "Server: Hello", "Server: World"
  } else {
    console.error('Stream error:', msg.payload.message);
  }
}
```

#### Client Cancellation

River supports client-side cancellation using AbortController. All procedure calls accept an optional `signal` parameter:

```ts
const controller = new AbortController();
const rpcResult = client.example.longRunning.rpc(
  { data: 'hello world' },
  { signal: controller.signal },
);

// cancel the operation
controller.abort();

// all cancelled operations will receive an error with CANCEL_CODE
const result = await rpcResult;
if (!result.ok && result.payload.code === 'CANCEL_CODE') {
  console.log('Operation was cancelled');
}
```

When a client cancels an operation, the server handler receives the cancellation via the `ctx.signal`:

```ts
const ExampleService = ServiceSchema.define({
  longRunning: Procedure.rpc({
    requestInit: Type.Object({}),
    responseData: Type.Object({ result: Type.String() }),
    async handler({ ctx }) {
      ctx.signal.addEventListener('abort', () => {
        // do something
      });

      // long running operation
      await new Promise((resolve) => setTimeout(resolve, 10000));
      return Ok({ result: 'completed' });
    },
  }),

  streamingExample: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: Type.Object({ message: Type.String() }),
    responseData: Type.Object({ echo: Type.String() }),
    async handler({ ctx, reqReadable, resWritable }) {
      // for streams, cancellation closes both readable and writable
      for await (const msg of reqReadable) {
        if (!msg.ok) {
          // msg.payload.code === CANCEL_CODE error if client cancelled
          break;
        }

        resWritable.write(Ok({ echo: msg.payload.message }));
      }

      resWritable.close();
    },
  }),
});
```

#### Codecs

River provides two built-in codecs:

- `NaiveJsonCodec`: Simple JSON serialization
- `BinaryCodec`: Efficient msgpack serialization (recommended for production)

```ts
import { BinaryCodec, NaiveJsonCodec } from '@replit/river/codec';

// use binary codec for better performance
const transport = new WebSocketClientTransport(
  async () => new WebSocket('ws://localhost:3000'),
  'my-client-id',
  { codec: BinaryCodec },
);
```

You can also create custom codecs for message serialization:

```ts
import { Codec } from '@replit/river/codec';

class CustomCodec implements Codec {
  toBuffer(obj: object): Uint8Array {
    // custom serialization logic
  }

  fromBuffer(buf: Uint8Array): object {
    // custom deserialization logic
  }
}

// use with transports
const transport = new WebSocketClientTransport(
  async () => new WebSocket('ws://localhost:3000'),
  'my-client-id',
  { codec: new CustomCodec() },
);
```

#### Custom Transports

You can implement custom transports by extending the base Transport classes:

```ts
import { ClientTransport, ServerTransport } from '@replit/river/transport';
import { Connection } from '@replit/river/transport';

// custom connection implementation
class MyCustomConnection extends Connection {
  private socket: MyCustomSocket;

  constructor(socket: MyCustomSocket) {
    super();
    this.socket = socket;

    this.socket.onMessage = (data: Uint8Array) => {
      this.dataListener?.(data);
    };

    this.socket.onClose = () => {
      this.closeListener?.();
    };

    this.socket.onError = (err: Error) => {
      this.errorListener?.(err);
    };
  }

  send(msg: Uint8Array): boolean {
    return this.socket.send(msg);
  }

  close(): void {
    this.socket.close();
  }
}

// custom client transport
class MyCustomClientTransport extends ClientTransport<MyCustomConnection> {
  constructor(
    private connectFn: () => Promise<MyCustomSocket>,
    clientId: string,
  ) {
    super(clientId);
  }

  async createNewOutgoingConnection(): Promise<MyCustomConnection> {
    const socket = await this.connectFn();
    return new MyCustomConnection(socket);
  }
}

// custom server transport
class MyCustomServerTransport extends ServerTransport<MyCustomConnection> {
  constructor(
    private server: MyCustomServer,
    clientId: string,
  ) {
    super(clientId);

    server.onConnection = (socket: MyCustomSocket) => {
      const connection = new MyCustomConnection(socket);
      this.handleConnection(connection);
    };
  }
}

// usage
const clientTransport = new MyCustomClientTransport(
  () => connectToMyCustomServer(),
  'client-id',
);

const client = createClient<ServiceSurface>(clientTransport, 'SERVER');
```

#### Testing

River provides utilities for testing your services:

```ts
import { createMockTransportNetwork } from '@replit/river/testUtil';

describe('My Service', () => {
  // create mock transport network
  const { getClientTransport, getServerTransport, cleanup } =
    createMockTransportNetwork();
  afterEach(cleanup);

  test('should add numbers correctly', async () => {
    // setup server
    const serverTransport = getServerTransport('SERVER');
    const services = {
      math: MathService,
    };
    const server = createServer(serverTransport, services);

    // setup client
    const clientTransport = getClientTransport('client');
    const client = createClient<typeof services>(clientTransport, 'SERVER');

    // test the service
    const result = await client.math.add.rpc({ a: 1, b: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.result).toBe(3);
    }
  });
});
```

#### Custom Handshake

River allows you to extend the protocol-level handshake so you can add additional logic to
validate incoming connections.

You can do this by passing extra options to `createClient` and `createServer` and extending the `ParsedMetadata` interface:

```ts
type ContextType = { ... }; // has to extend object
type ParsedMetadata = { parsedToken: string };
const ServiceSchema = createServiceSchema<ContextType, ParsedMetadata>();

const services = { ... }; // use custom ServiceSchema builder here

const handshakeSchema = Type.Object({ token: Type.String() });
createClient<typeof services>(new MockClientTransport('client'), 'SERVER', {
  eagerlyConnect: false,
  handshakeOptions: createClientHandshakeOptions(handshakeSchema, async () => ({
    // the type of this function is
    // () => Static<typeof handshakeSchema> | Promise<Static<typeof handshakeSchema>>
    token: '123',
  })),
});

createServer(new MockServerTransport('SERVER'), services, {
  handshakeOptions: createServerHandshakeOptions(
    handshakeSchema,
    (metadata, previousMetadata) => {
      // the type of this function is
      // (metadata: Static<typeof<handshakeSchema>, previousMetadata?: ParsedMetadata) =>
      //   | false | Promise<false> (if you reject it)
      //   | ParsedMetadata | Promise<ParsedMetadata> (if you allow it)
      // next time a connection happens on the same session, previousMetadata will
      // be populated with the last returned value
      return { parsedToken: metadata.token };
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

   - Create a PR that bumps the version in `package.json` and `package-lock.json`. You can run `pnpm version --no-git-tag-version <version>` to bump the version.
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

5. **Manual npm release**:
   - If the auto-publish workflow failed, you can run `npm run release` locally
