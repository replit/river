# Spawn

## The problem with concurrent operations

Operations are lazy — calling a generator function creates an Operation that
does nothing until interpreted with `yield*`. This means you can't just call
two operations and `yield*` them later like you would with Promises:

```js
// This still runs sequentially!
main(function* () {
  let dayUS = fetchWeekDay("est");
  let daySweden = fetchWeekDay("cet");
  console.log(`${yield* dayUS} and ${yield* daySweden}`);
});
```

Using `run()` to start both operations has the same problem as `async/await`:
a failure in one has no effect on the other (dangling promises).

## Introducing spawn

`spawn()` creates a child task tied to the current scope:

```js
import { main, spawn } from "effection";
import { fetchWeekDay } from "./fetch-week-day";

main(function* () {
  let dayUS = yield* spawn(() => fetchWeekDay("est"));
  let daySweden = yield* spawn(() => fetchWeekDay("cet"));
  console.log(`${yield* dayUS} and ${yield* daySweden}`);
});
```

This creates a hierarchy:

```
+-- main
  |
  +-- fetchWeekDay('est')
  |
  +-- fetchWeekDay('cet')
```

When `fetchWeekDay('cet')` fails, it causes `main` to fail, which halts all
remaining children:

```
+-- main [FAILED]
  |
  +-- fetchWeekDay('est') [HALTED]
  |
  +-- fetchWeekDay('cet') [FAILED]
```

An error in a child causes the parent to error, which halts siblings. This is
[structured concurrency](https://vorpus.org/blog/notes-on-structured-concurrency-or-go-statement-considered-harmful/).

## Using combinators

The `all()` combinator runs operations concurrently:

```js
import { all, main } from "effection";

main(function* () {
  let [dayUS, daySweden] = yield* all([
    fetchWeekDay("est"),
    fetchWeekDay("cet"),
  ]);
  console.log(`${dayUS} and ${daySweden}`);
});
```

## Spawning in a Scope

Use `useScope()` to capture a scope, then `scope.run()` to spawn operations
from non-Effection code:

```js
import express from "express";
import { main, suspend, useScope } from "effection";

await main(function* () {
  let scope = yield* useScope();
  let app = express();

  app.get("/", async (_, res) => {
    await scope.run(function* () {
      res.send("Hello World!");
    });
  });

  let server = app.listen();
  try {
    yield* suspend();
  } finally {
    server.close();
  }
});
```

Every request runs inside the main scope. When someone hits `CTRL-C`, in-flight
requests are cancelled.
