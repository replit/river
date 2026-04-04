# @effectionx/test-adapter

Abstract helper for integrating Effection with testing frameworks. Use a
specific framework adapter (e.g., `@effectionx/vitest`) instead of this
directly.

## Installation

```
npm install @effectionx/test-adapter
```

## Core types

### `TestOperation`

```ts
type TestOperation = () => Operation<void>;
```

### `TestAdapter`

- `parent?` — Ancestor adapter whose setup runs alongside this adapter's.
- `name` — Identifier for debugging.
- `fullname` — Qualified name including ancestors (e.g.,
  `"All Tests > File System > write"`).
- `lineage` — Array of this adapter and all ancestors.
- `setup` — Operations associated with this adapter only.
- `addSetup(op)` — Register operations to run before each test
  (`beforeEach`).
- `addOnetimeSetup(op)` — Register operations to run once before tests
  (`beforeAll`).
- `runTest(op)` — Execute all setup operations then the test body.
- `destroy()` — Teardown the associated Effection scope.

### `createTestAdapter(options?)`

Create a new test adapter. Accepts `{ name?, parent? }`.
