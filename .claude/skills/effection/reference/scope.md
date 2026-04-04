# Scope

Every operation in Effection runs in the context of an associated scope which
places a hard limit on how long it will live.

## Scope of a lifetime

```js
import { main, sleep, spawn } from "effection";

await main(function* () {
  yield* spawn(function* () {
    for (let i = 1; i <= 10; i++) {
      yield* sleep(1000);
      console.log(i);
    }
  });

  yield* sleep(5000);
});
```

This script outputs only five numbers, not ten. The main operation completes
after five seconds, and its scope (and every scope it contains) is halted.

**Key concept: no operation may outlive its scope.**

This is analogous to lexical scope in JavaScript — when variables pass out of
scope, their memory is reclaimed. Effection applies the same principle to
entire operations.

## The three outcomes

There are only three ways an operation may pass out of scope:

1. **return** — the operation completes to produce a value.
2. **error** — the operation fails and exits with an exception.
3. **halt** — due to a return, error, or halt of a related operation.

No matter which one, every sub-operation is automatically destroyed.

## Halting and immediate return

When a task is halted, `return()` is called on its generator. This behaves as
if the current `yield*` statement were replaced with a `return` statement.
Crucially, `try/finally` still works:

```js
import { run, sleep, suspend } from "effection";

let task = run(function* () {
  try {
    yield* suspend();
  } finally {
    console.log("yes, this will be printed!");
  }
});

await task.halt();
```

## Cleaning up

Use `try/finally` to run cleanup when an operation shuts down:

```js
import { run, suspend } from "effection";
import { createServer } from "http";

let task = run(function* () {
  let server = createServer();
  try {
    yield* suspend();
  } finally {
    server.close();
  }
});

await task.halt();
```

## Asynchronous halt

You can `yield*` inside a `finally` block — Effection handles it. However,
keep halting speedy and simple. Avoid expensive operations during halt and
avoid throwing errors during halting.

## Ensure

Use `ensure()` to avoid rightward drift from many `try/finally` blocks:

```js
import { run, ensure } from "effection";
import { createServer } from "http";

let task = run(function* () {
  let server = createServer();
  yield* ensure(() => {
    server.close();
  });
  yield* suspend();
});

await task.halt();
```

## Abort Signal

Use `useAbortSignal()` to create an `AbortSignal` bound to the current scope.
It aborts when the scope exits:

```js
import { main, sleep, useAbortSignal } from "effection";

await main(function* () {
  let signal = yield* useAbortSignal();

  signal.addEventListener("abort", () => console.log("done!"));

  yield* sleep(5000);
  // prints 'done!'
});
```

Pass the signal to APIs that accept `AbortSignal` (like `fetch`):

```js
function* request(url) {
  let signal = yield* useAbortSignal();
  let response = yield* until(fetch(url, { signal }));
  if (response.ok) {
    return yield* until(response.text());
  } else {
    throw new Error(`failed: ${response.status}: ${response.statusText}`);
  }
}
```

## Embedding API

### Capturing a Scope from a running Operation

Use `useScope()` to capture the current scope, then `scope.run()` to spawn
operations from non-Effection code (e.g., express handlers):

```js
import { until, ensure, main, useScope, useAbortSignal, suspend } from "effection";
import express from "express";

await main(function* () {
  let scope = yield* useScope();
  let app = express();

  app.get("/", async (req, res) => {
    await scope.run(function* () {
      let signal = yield* useAbortSignal();
      let response = yield* until(fetch(`https://google.com?q=${req.params.q}`, { signal }));
      res.send(yield* until(response.text()));
    });
  });

  let server = app.listen();
  yield* ensure(() => {
    server.close();
  });
  yield* suspend();
});
```

### Creating a brand new Scope

Use `createScope()` for integration with non-Effection lifecycle management:

```js
async function main() {
  await using scope = createScope();

  scope
    .run(function* () {
      let response = yield* until(fetch("http://example.com"));
      return yield* until(response.text());
    })
    .then((response) => console.log(response));

  await scope.run(sleep(1000));
} //=> scope is destroyed!
```

For test cases with manual destruction:

```js
let scope;
let destroy;

beforeEach(() => {
  [scope, destroy] = createScope();
});

it("does something", async () => {
  await scope.run(function* () {
    // run operations in test case
  });
});

afterEach(async () => {
  await destroy();
});
```

Always `await` the destruction operation when the scope is no longer needed.
