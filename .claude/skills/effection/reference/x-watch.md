# @effectionx/watch

Run commands and restart them gracefully when source files change.

## Installation

```
npm install @effectionx/watch
```

## CLI usage

```
deno -A jsr:@effectionx/watch npm start
```

## Library usage

```ts
import { each, main } from "effection";
import { watch } from "@effectionx/watch";

await main(function* () {
  const changes = watch({
    path: "./src",
    cmd: "npm test",
  });

  for (let start of yield* each(changes)) {
    console.log(start);
    yield* each.next();
  }
});
```

## WatchOptions

- `path` — Directory to monitor (required).
- `cmd` — Command to execute repeatedly (required).
- `execOptions?` — Configuration passed to process exec.

## `watch(options): Stream<Start, never>`

Returns a stream emitting process starts in response to file system changes.

## Behavior

- Sends SIGINT/SIGTERM and waits for stdout to close before restarting.
- In git repos, monitors only tracked/eligible files (excludes gitignored).
