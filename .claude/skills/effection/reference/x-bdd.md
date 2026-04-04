# @effectionx/bdd

BDD testing harness with `describe`/`it`/`beforeEach` for Effection operations.

## Installation

```
npm install @effectionx/bdd
```

## Overview

Provides a BDD-style testing interface where test functions are Effection
generator functions (`function*`) instead of async functions. Tests run within
Effection scopes, so resources are properly cleaned up between tests.

## Expected API

- `describe(name, fn)` — Group related tests.
- `it(name, op)` — Define a test as a generator function.
- `beforeEach(op)` — Setup to run before each test.
- `beforeAll(op)` — Setup to run once before all tests.

See `@effectionx/vitest` for a concrete Vitest integration built on this
pattern.
