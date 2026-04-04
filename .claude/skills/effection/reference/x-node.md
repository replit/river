# @effectionx/node

Node.js integration utilities — adapters for streams and event emitters.

## Installation

```
npm install @effectionx/node
```

## Stream utilities (`@effectionx/node/stream`)

### `fromReadable(readable)`

Convert a Node.js `Readable` stream to an Effection `Stream<Uint8Array, void>`.
Automatically manages listeners and cleanup.

## Event utilities (`@effectionx/node/events`)

### `on(emitter, event)`

Create a `Stream<T, never>` of events from any `EventEmitter` or
`EventTarget`-like object. Works with Node.js EventEmitters, DOM EventTargets,
and web workers.

### `once(emitter, event)`

Create an `Operation<TArgs>` that yields the next event emission.

## Supported interfaces

- **`EventEmitterLike`** — Requires `on()` and `off()` methods.
- **`EventTargetLike`** — Requires `addEventListener()` and
  `removeEventListener()` methods.
- **`EventSourceLike`** — Union type accepting either interface.
