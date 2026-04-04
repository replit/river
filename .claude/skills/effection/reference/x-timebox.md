# @effectionx/timebox

Constrain operations to complete within a time limit.

## Installation

```
npm install @effectionx/timebox
```

## API

### `timebox<T>(limitMS: number, operation: () => Operation<T>): Operation<Timeboxed<T>>`

Returns either a successful result or a timeout indicator.

## Return types

**`Completed<T>`** (success):

- `timeout: false`
- `value: T`
- `start: DOMHighResTimeStamp`
- `end: DOMHighResTimeStamp`

**`Timeout`** (exceeded):

- `timeout: true`
- `start: DOMHighResTimeStamp`
- `end: DOMHighResTimeStamp`

## Usage

```ts
import { timebox } from "@effectionx/timebox";

let result = yield* timebox(10_000, function* () {
  // operation that must complete within 10 seconds
  return yield* fetchData();
});

if (result.timeout) {
  // handle timeout (e.g., return 504)
} else {
  // use result.value
}
```
