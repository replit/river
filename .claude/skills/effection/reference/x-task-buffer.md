# @effectionx/task-buffer

Limit concurrent task execution with automatic queuing.

## Installation

```
npm install @effectionx/task-buffer
```

## API

### `useTaskBuffer(max: number): Operation<TaskBuffer>`

Creates a `TaskBuffer` within the current scope with a maximum concurrent task
limit. When the limit is reached, additional spawn requests are queued and
processed as capacity becomes available.

## Usage

```ts
import { run, sleep } from "effection";
import { useTaskBuffer } from "@effectionx/task-buffer";

await run(function* () {
  const buffer = yield* useTaskBuffer(2);

  yield* buffer.spawn(() => sleep(10));
  yield* buffer.spawn(() => sleep(10));
  yield* buffer.spawn(() => sleep(10)); // queued until a slot opens
  yield* yield* buffer.spawn(() => sleep(10)); // waits for completion
  yield* buffer; // waits for all tasks to complete
});
```
