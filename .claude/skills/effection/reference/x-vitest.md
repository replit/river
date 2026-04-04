# @effectionx/vitest

Vitest adapter for writing tests as Effection generator functions.

## Installation

```
npm install @effectionx/vitest
```

## Exports

- `describe` — Group related tests.
- `it(desc, op?, timeout?)` — Define a test using `function*`.
- `it.only` — Run only this test.
- `it.skip` — Skip this test.
- `beforeAll(op)` — Run once before all tests.
- `beforeEach(op)` — Run before each test.
- `captureError<T>(op: Operation<T>): Operation<Error>` — Capture errors from
  operations as values.

## Usage

```ts
import { describe, it, beforeEach } from "@effectionx/vitest";
import { sleep } from "effection";

describe("my feature", () => {
  beforeEach(function* () {
    // setup resources
  });

  it("works", function* () {
    yield* sleep(100);
    // assertions
  });
});
```
