# Resources

The `resource()` operation exists for operations that are:

1. Long running
2. Need to be interacted with while running

## The problem

Consider creating a Socket and sending messages while it's open. A naive
operation that suspends to keep the socket alive will block forever:

```js
// This blocks forever — suspend() never returns
export function* useSocket(port, host) {
  let socket = new Socket();
  socket.connect(port, host);
  yield* once(socket, "connect");

  try {
    yield* suspend();
    return socket; // never reached
  } finally {
    socket.close();
  }
}
```

## The solution: resource()

```js
import { once, resource } from "effection";

export function useSocket(port, host) {
  return resource(function* (provide) {
    let socket = new Socket();
    socket.connect(port, host);
    yield* once(socket, "connect");

    try {
      yield* provide(socket);
    } finally {
      socket.close();
    }
  });
}
```

Usage is unchanged:

```js
import { main } from "effection";
import { useSocket } from "./use-socket";

await main(function* () {
  let socket = yield* useSocket(1337, "127.0.0.1");
  socket.write("hello");
  // once main finishes, the socket is closed
});
```

The body of a resource initializes a value and makes it available via
`provide()`. The `provide()` operation passes control back to the caller with
the value as its result, then remains suspended until the resource passes out
of scope, guaranteeing cleanup.

**Mantra: resources _provide_ values.**

## Composing resources

Resources can depend on other resources:

```js
import { main, resource, spawn, sleep } from "effection";
import { useSocket } from "./use-socket";

function useHeartSocket(port, host) {
  return resource(function* (provide) {
    let socket = yield* useSocket(port, host);

    yield* spawn(function* () {
      while (true) {
        yield* sleep(10_000);
        socket.send(JSON.stringify({ type: "heartbeat" }));
      }
    });

    yield* provide(socket);
  });
}

await main(function* () {
  let socket = yield* useHeartSocket(1337, "127.0.0.1");
  socket.write({ hello: "world" });
  // once main finishes:
  // 1. the heartbeat is stopped
  // 2. the socket is closed
});
```

## Using ensure() in resources

The `ensure()` operation works in resources as an alternative to `try/finally`:

```js
import { ensure, once, resource } from "effection";

export function useSocket(port, host) {
  return resource(function* (provide) {
    let socket = new Socket();
    yield* ensure(() => {
      socket.close();
    });

    socket.connect(port, host);
    yield* once(socket, "connect");
    yield* provide(socket);
  });
}
```
