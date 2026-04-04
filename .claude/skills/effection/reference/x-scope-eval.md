# @effectionx/scope-eval

Evaluate operations in a scope while retaining resources across evaluations.

## Installation

```
npm install @effectionx/scope-eval
```

## Core functions

### `useEvalScope()`

Creates an isolated scope with:

- `scope: Scope` — for inspecting context values.
- `eval<T>(op: () => Operation<T>): Operation<Result<T>>` — executes operations
  and returns results as data (not thrown exceptions).

### `box(operation)`

Wraps operation execution, capturing results as `Result<T>` objects.

### `unbox(result)`

Extracts values from `Result<T>`, throwing if an error occurred.

## Use cases

- Testing: evaluate operations and inspect context without resource cleanup.
- Maintaining resource availability across sequential evaluations.
- Creating error boundaries for potentially failing operations.

## Key difference from `Scope.run` / `Scope.spawn`

Operations evaluated via `eval()` maintain their context modifications within
the spawned scope, enabling state inspection after execution without teardown.
