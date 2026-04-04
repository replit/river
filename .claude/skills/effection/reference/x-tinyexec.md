# @effectionx/tinyexec

Lightweight process execution wrapper around the tinyexec package.

## Installation

```
npm install @effectionx/tinyexec
```

## API

### `x(cmd: string, args?: string[], options?: Partial<Options>): Operation<TinyProcess>`

Execute an OS process. The process is automatically destroyed when it passes
out of scope.

### `TinyProcess`

- `lines` — A `Stream` delivering output from both stdout and stderr.
  Terminates when the process ends.
- `kill(signal?: KillSignal)` — Send a signal to the process.

## Usage

```ts
import { x } from "@effectionx/tinyexec";

let proc = yield* x("echo", ["hello"]);

for (let line of yield* each(proc.lines)) {
  console.log(line);
  yield* each.next();
}
```
