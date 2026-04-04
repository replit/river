# @effectionx/stream-helpers

Type-safe stream operators for Effection streams. All helpers compose via
`pipe()` and maintain full type safety.

## Installation

```
npm install @effectionx/stream-helpers
```

## Transform operators

- **`filter(predicate)`** — Narrows a stream to items matching a predicate.
  Supports sync and async predicates.
- **`map(fn)`** — Transforms individual stream items.
- **`reduce(fn, initial)`** — Accumulates values, yielding intermediate results.
- **`batch(options)`** — Groups items into arrays by size threshold, time
  window, or both.
- **`lines()`** — Transforms binary chunk streams into line-delimited text
  streams.

## Backpressure

- **`valve(options)`** — Buffers items and triggers pause/resume based on
  configurable thresholds.

## Selection operators

- **`first()` / `first.expect()`** — First stream value (or throw on empty).
- **`last()` / `last.expect()`** — Last stream value (or throw on empty).
- **`take(n)`** — Yield exactly n items.
- **`takeWhile(predicate)`** — Yield while predicate is true, close without the
  failing value.
- **`takeUntil(predicate)`** — Yield until predicate matches, close with the
  matching value.

## Side effects

- **`forEach(fn)`** — Execute side effects on each item without
  transformation.
- **`drain()`** — Consume entire stream discarding values, return close value.

## Multicasting

- **`subject()`** — Multicast stream replaying latest value to new subscribers
  (like RxJS BehaviorSubject).

## Testing

- **`faucet(items)`** — Controllable test source stream supporting sync arrays
  and async generators with backpressure simulation.
- **`passthrough()`** — Tracker verifying all stream items exit, ensuring
  complete processing.
