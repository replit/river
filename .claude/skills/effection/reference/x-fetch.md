# @effectionx/fetch

Effection-native HTTP fetch with structured concurrency and streaming response
support.

## Installation

```
npm install @effectionx/fetch effection
```

## Fluent API

Chain methods directly on `fetch()`:

```ts
let data = yield* fetch("/api/data").json();
let text = yield* fetch("/page").text();
let body = yield* fetch("/large").body(); // stream chunks
```

Use `.expect()` to throw `HttpError` on non-2xx responses:

```ts
let data = yield* fetch("/api").expect().json();
```

## Traditional API

```ts
let response = yield* fetch("/api");
let data = yield* response.json();
```

## Key types

- **`FetchOperation`** — Chainable fetch operation. Can be yielded to get a
  `FetchResponse`.
- **`FetchResponse`** — Wrapper around native `Response` with operation-based
  body readers: `.json()`, `.text()`, `.arrayBuffer()`, `.blob()`,
  `.formData()`, `.body()`.
- **`FetchInit`** — Request options matching `RequestInit` but excluding
  `signal` (Effection handles cancellation automatically).
- **`HttpError`** — Custom error thrown on non-2xx when using `.expect()`.

## Structured concurrency

Requests automatically abort when the Effection scope exits. No manual signal
management needed.
