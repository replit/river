# @effectionx/signals

Reactive signals and computed values for Effection operations. Immutable state
containers that work without a UI framework.

## Installation

```
npm install @effectionx/signals
```

## Signal types

All signals extend `ValueSignal<T>` — a stream that emits current and updated
values on modification.

### `BooleanSignal`

Manages boolean state changes.

### `ArraySignal`

Handles immutable array values with methods like `push()` and `shift()`.

### `SetSignal`

Represents Set data structures with `add()`, `delete()`, and `difference()`.

## Common methods

- `set(value)` — Set the value.
- `update(fn)` — Update via a function.
- `valueOf()` — Get the current value.

## Helpers

### `is(signal, predicate)`

Wait until the value of the stream matches the predicate. Useful for checking
array length, boolean state, etc.
