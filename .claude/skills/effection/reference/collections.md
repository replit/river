# Collections: Streams, Subscriptions, Channels, Signals, Queues

## Core equivalents

| Async/Await     | Effection      |
| --------------- | -------------- |
| `Promise`       | `Operation`    |
| `await`         | `yield*`       |
| `async function`| `function*`    |
| `AsyncIterator` | `Subscription` |
| `AsyncIterable` | `Stream`       |
| `for await`     | `for yield*`   |

## Subscriptions

A `Subscription` is a stateful queue that returns Operations yielding iterator
results, mirroring `AsyncIterator` behavior. You'll rarely use them directly.

## Streams

A `Stream` is a stateless recipe for creating subscriptions. A single stream
can support multiple concurrent subscriptions, each receiving identical values.

## Consuming streams with `each()`

```js
for (let value of yield* each(stream)) {
  // process value
  yield* each.next(); // REQUIRED at end of every iteration
}
```

You **must** call `yield* each.next()` as the last step of every loop
iteration, even when using `continue`.

## Concurrent consumption

When sending values to a stream requires concurrent operations, use `spawn()`
to prevent blocking:

```js
for (let value of yield* each(stream)) {
  yield* spawn(function* () {
    // handle value concurrently
  });
  yield* each.next();
}
```

## Closing streams

Streams optionally support a final value when exhausted (iterator result where
`done` is true). Use a `while` loop to access it:

```js
let subscription = yield* stream;
let next = yield* subscription.next();
while (!next.done) {
  console.log(next.value);
  next = yield* subscription.next();
}
console.log("final value:", next.value);
```

## Creating streams from external events

Use `createSignal()` to bridge synchronous callbacks into Effection streams:

```js
import { createSignal } from "effection";

let signal = createSignal<MouseEvent>();

document.addEventListener("click", (event) => signal.send(event));

// Later, consume as a stream:
for (let event of yield* each(signal)) {
  console.log(event.clientX, event.clientY);
  yield* each.next();
}
```

## Channel vs Signal vs Queue

| Concept   | Send from                      | Send API                  | Requires subscribers    | Buffering                       |
| --------- | ------------------------------ | ------------------------- | ----------------------- | ------------------------------- |
| `Channel` | inside operations              | `send(): Operation<void>` | yes (otherwise dropped) | per-subscriber while subscribed |
| `Signal`  | outside operations (callbacks) | `send(): void`            | yes (otherwise no-op)   | per-subscriber while subscribed |
| `Queue`   | anywhere (single consumer)     | `add(): void`             | no                      | buffered (single subscription)  |
