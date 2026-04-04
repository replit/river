# @effectionx/converge

Poll and wait for conditions to be met with automatic retry and timeout.
Adapted from @bigtest/convergence.

## Installation

```
npm install @effectionx/converge
```

## Core functions

### `when(assertion, options?)`

Converges when assertions pass within timeout. Runs the assertion repeatedly
until it passes or times out.

- Default timeout: 2000ms
- Default interval: 10ms
- Throws if assertion never passes within timeout

### `always(assertion, options?)`

Converges when assertions pass throughout the entire timeout period. Fails
immediately if the assertion fails at any point.

- Default timeout: 200ms
- Default interval: 10ms

## Options

| Option     | Type   | Default    | Purpose            |
| ---------- | ------ | ---------- | ------------------ |
| `timeout`  | number | 2000 / 200 | Maximum wait time  |
| `interval` | number | 10         | Retry frequency ms |

## Return value

Both functions return `ConvergeStats<T>`:

- `start`, `end`, `elapsed` — timestamps
- `runs` — number of attempts
- `timeout`, `interval` — settings used
- `value` — assertion return value
