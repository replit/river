# @effectionx/effect-ts

Bidirectional interop between Effect-TS and Effection.

## Installation

```
npm install @effectionx/effect-ts
```

Requires `effect` (^3) and `effection` (^3 || ^4) as peer dependencies.

## Two integration patterns

### Effection host, Effect guest

Use `makeEffectRuntime()` to run Effect programs within Effection operations.

**EffectRuntime** provides:

- `run<A, E>(effect)` — Returns `Operation<A>`, throws JS errors on failure.
- `runExit<A, E>(effect)` — Returns `Operation<Exit<A, E>>`, preserves full
  Effect error type information.

### Effect host, Effection guest

Use `makeEffectionRuntime()` to run Effection operations within Effect programs.

**EffectionRuntime** provides:

- `run<T>(operation)` — Returns `Effect<T, UnknownException>`.

## Resource management

Both runtimes implement automatic cleanup through scope management — Effect
resources dispose when Effection scopes end, and Effection scopes close when
Effect scopes complete or interrupt.
