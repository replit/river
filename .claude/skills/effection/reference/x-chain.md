# @effectionx/chain

Promise-like chaining for Effection operations. Covers use cases where there is
no 1:1 analogue between Promises and Operations.

## Installation

```
npm install @effectionx/chain
```

## Core API

- **`Chain<T>`** — Main class with `.then()`, `.catch()`, `.finally()` methods
  that accept Operation callbacks (not plain functions).
- **`Resolve<T>`** — Type for resolving a Chain.
- **`Reject`** — Type for rejecting a Chain.

## Usage

```ts
let chain = new Chain<number>((resolve) => {
  resolve(10);
});

let result = yield* chain.then(function* (value) {
  return value * 2;
});
// result === 20
```

## Use cases

- Storing and reusing operations across multiple locations (shared data calls)
- Chaining transformations on operation results
