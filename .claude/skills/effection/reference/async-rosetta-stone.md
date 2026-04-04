# Async Rosetta Stone

Effection maps standard JavaScript async constructs to generator-based
equivalents:

| Async/Await             | Effection                  |
| ----------------------- | -------------------------- |
| `await`                 | `yield*`                   |
| `async function`        | `function*`                |
| `Promise`               | `Operation`                |
| `new Promise()`         | `action()`                 |
| `Promise.withResolvers` | `withResolvers()`          |
| `for await`             | `for yield* each`          |
| `AsyncIterable`         | `Stream`                   |
| `AsyncIterator`         | `Subscription`             |

## Key differences

- When constructing operations with `action()`, the action executor must return
  a cleanup function that runs regardless of whether the action is resolved,
  rejected, or discarded.

- `until()` transforms a Promise into an Operation.
- `run()` and `Scope.run()` convert Operations back to Promises for interop.

This design lets JavaScript developers leverage structured concurrency without
abandoning the syntax patterns they already understand.
