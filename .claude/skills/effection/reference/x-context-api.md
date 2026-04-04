# @effectionx/context-api

Algebraic/contextual effects — define operations that behave differently in
different contexts through middleware wrapping.

## Installation

```
npm install @effectionx/context-api
```

## Core API

- **`createApi()`** — Factory returning an `Api` instance with `operations` and
  `around` method.
- **`Api<A>`** — Interface providing operations and the `around` middleware
  wrapper.
- **`Around`** — Middleware wrapper type.
- **`Middleware`** — Function accepting args and a `next` callback.

## Key concepts

- Middleware is only in effect inside the scope in which it is installed.
- Use `around()` to inject custom behavior around API operations.

## Use cases

- Automatic instrumentation (e.g., tracing fetch calls)
- Mocking within test scenarios
- Custom logging implementations
- Behavior modification without changing original code
