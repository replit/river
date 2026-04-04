# @effectionx/jsonl-store

Streaming JSONL document store with glob-based file selection. Useful for
caching HTTP responses.

## Installation

```
npm install @effectionx/jsonl-store
```

## Basic usage

```ts
import { useStore } from "@effectionx/jsonl-store";

const store = yield* useStore(); // default location: .store/
```

## Operations

- `write(key, data)` — Store data at a given key.
- `append(key, data)` — Add data to existing key.
- `read<T>(key)` — Stream all values from a key.
- `find<T>(glob)` — Stream content from glob-matched files.
- `has(key)` — Check key existence.
- `clear()` — Remove all store contents.

## Custom location

```ts
import { JSONLStore } from "@effectionx/jsonl-store";

const store = JSONLStore.from({ location: "./my-cache/" });
```

## Types

- **`Store`** — Interface defining the store contract.
- **`StoreContext`** — Context provider for dependency injection.
- **`StoreConstructorOptions`** — Configuration with required `location`
  property (URL or string).
