# River + Effection: A Vision for Structured Concurrency

## The Philosophical Shift

River today is a framework that *fights* concurrency. It builds walls around
it — state machines to prevent invalid transitions, Proxy objects to prevent
use-after-free, manual event listener bookkeeping, AbortControllers threaded
through call stacks, and a `ReadableImpl` class that reimplements half of
CSP-style channels from scratch. Every one of these mechanisms exists because
JavaScript's `async/await` gives you no tools for *owning* concurrent work.
You start a promise; it runs until it finishes. You have no way to say
"this work belongs to this scope and must end when the scope ends."

Effection inverts this. Work is owned by scopes. When a scope exits — whether
by completion, error, or external halt — all work spawned within it is
torn down, reliably, in reverse order. `try/finally` works during teardown.
Cleanup is not an afterthought bolted onto the happy path; it is a first-class
guarantee of the execution model.

This is not a superficial API change. It is a change in *what the code is
allowed to assume*. Today, every River module must independently solve the
problem of "what happens if the thing I depend on is gone?" With Effection,
the answer is always the same: if the thing you depend on is gone, you have
already been halted. You don't need to check. You don't need a state machine
to prevent accessing consumed state. You don't need a Proxy. The runtime
*structurally prevents* the situation from arising.

## What Dissolves

### The Session State Machine

The session state machine (`transport/sessionStateMachine/`) is the most
complex subsystem in River. It has 6 states, a class hierarchy 4 levels deep,
Proxy-based consumption guards, and ~3,600 lines across 9 files. It exists
to answer one question: **"What is the current relationship between this
client and this server, and what operations are legal right now?"**

In Effection, a session is a `resource()`. It `provide()`s a send function
and a message stream. While the resource is alive, you can send and receive.
When the resource's scope exits, you can't — not because a Proxy throws, but
because the generator that was using the resource has been halted. There is
no "consumed state" to protect against because there is no stale reference
to dangle.

The reconnection loop is not a state machine. It is a loop:

```ts
function* useClientSession(transport, to) {
  return yield* resource(function* (provide) {
    let retries = 0;
    while (true) {
      try {
        let conn = yield* connect(transport, to);
        let session = yield* handshake(conn, ...);
        retries = 0; // reset on success
        yield* provide(session);
      } catch (e) {
        retries++;
        if (retries > maxRetries) throw e;
        yield* sleep(backoff(retries));
      }
    }
  });
}
```

Backoff is `sleep()`. Connection timeout is `race([connect(...), sleep(timeout)])`.
Grace period is the natural lifetime of the resource scope — it lives as long
as the parent scope allows it. No `setTimeout`. No `clearTimeout`. No
`gracePeriodTimeout` field. No `_handleStateExit`. No `_handleClose`. No
`StateMachineState` base class. No Proxy.

The 6-state machine (NoConnection, BackingOff, Connecting, Handshaking,
Connected, WaitingForHandshake) becomes implicit in the control flow of a
generator function. You can *read* what state you're in by looking at which
`yield*` the generator is suspended on. The states are not reified into
objects — they are positions in code.

### The EventDispatcher

River's `EventDispatcher` is a pub/sub system that routes transport events
(messages, session status, protocol errors) to listeners. Listeners are
registered and unregistered manually, creating a bookkeeping burden that
pervades the codebase — every `addEventListener` must have a corresponding
`removeEventListener`, and getting this wrong leaks memory or causes
use-after-dispose bugs.

In Effection, events are **streams**. A transport's incoming messages are a
`Stream<TransportMessage>`. Session status changes are a
`Stream<SessionStatusEvent>`. Consuming a stream ties its lifetime to the
consumer's scope — when the scope exits, the subscription is cleaned up
automatically. No manual listener management. No `unregisterTransportListeners`.

### ReadableImpl / WritableImpl

`ReadableImpl` is a hand-rolled async channel with:
- A queue (`Array<T>`)
- Promise-based signaling (`PromiseWithResolvers`)
- Locking semantics (single consumer)
- Break semantics (error injection)
- Close tracking

This is exactly what Effection's `Queue` or `Channel` provides natively.
A procedure's request stream is a `Queue` — values are buffered regardless
of subscriber timing, and consumption is via `yield* queue.next()`. A
procedure's response stream is a `Channel` where the handler `yield* send()`s
results.

The entire 412-line `streams.ts` file dissolves. The `Readable` and `Writable`
**interfaces** remain as the public API (they are user-facing), but their
internal implementation becomes thin wrappers around Effection primitives
rather than a bespoke async channel implementation.

### Manual Cleanup Orchestration

Today, cleanup in River is a manual dance:

```ts
// server.ts createNewProcStream
const deferredCleanups: Array<() => void | Promise<void>> = [];
let cleanupsHaveRun = false;
const runCleanupSafe = async (fn) => { try { await fn() } catch ... };
const deferCleanup = (fn) => { ... };
const runDeferredCleanups = async () => { ... };
const cleanup = () => {
  finishedController.abort();
  this.streams.delete(streamId);
  void runDeferredCleanups();
};
```

In Effection, this is:

```ts
yield* ensure(() => { streams.delete(streamId) });
```

Or more precisely, it's *nothing* — because streams spawned in a scope are
automatically cleaned up when that scope exits. The `deferCleanup` API maps
directly to `ensure()`. The `finishedController` (AbortController) maps to
`useAbortSignal()`. The LIFO cleanup ordering is Effection's default.

### The AbortController / AbortSignal Pattern

River creates `AbortController` instances and threads their signals through
handler contexts so that procedure handlers can observe cancellation:

```ts
const finishedController = new AbortController();
// ... later ...
handlerContextWithSpan.signal = finishedController.signal;
// ... and on cancel ...
finishedController.abort();
```

In Effection:

```ts
const signal = yield* useAbortSignal();
handlerContext.signal = signal;
// No manual abort needed — signal fires when scope exits
```

## What Emerges

### Sessions as Resources

A session is a resource that provides a message-sending capability and a
message-receiving stream. The session resource encapsulates:
- Connection establishment (with retry/backoff)
- Handshake negotiation
- Heartbeat management (via `spawn`ed background task)
- Message ordering and acknowledgment
- Transparent reconnection (via loop within the resource)

When the session resource's scope exits, all of these concerns are torn down
in reverse order. Heartbeat stops. Connection closes. Telemetry span ends.
No explicit teardown code beyond `try/finally` blocks in the resource body.

### Procedure Streams as Scoped Operations

A procedure invocation on the server becomes a spawned operation:

```ts
yield* spawn(function* () {
  // This scope owns the entire procedure lifecycle
  let signal = yield* useAbortSignal();
  yield* ensure(() => streams.delete(streamId));

  let reqQueue = createQueue();    // incoming request messages
  let resChannel = createChannel(); // outgoing response messages

  // spawn response sender
  yield* spawn(function* () {
    for (let msg of yield* each(resChannel)) {
      send(msg);
      yield* each.next();
    }
  });

  // run handler
  yield* handler({ ctx, reqReadable: reqQueue, resWritable: resChannel });

  // when handler returns, this scope exits:
  //   → response sender is halted
  //   → reqQueue/resChannel are cleaned up
  //   → streams.delete(streamId) runs via ensure
  //   → signal is aborted
});
```

The "what if the handler throws?" question has one answer: the scope errors,
all children are halted, cleanup runs. No `onHandlerError` callback. No
`cleanClose` flag tracking. No `if (resWritable.isClosed()) return` guards
scattered throughout.

### Transport as a Resource

The transport itself becomes a resource:

```ts
function* useTransport(options) {
  return yield* resource(function* (provide) {
    let messages = createSignal();  // incoming messages
    let sessions = new Map();
    // ... setup ...
    yield* provide({ messages, sessions, send, ... });
    // resource stays alive until scope exits
    // then all sessions are torn down automatically
  });
}
```

### Heartbeats as Spawned Loops

Today, heartbeats use `setInterval` and `setTimeout` with manual cleanup:

```ts
this.heartbeatHandle = setInterval(() => { ... }, intervalMs);
// ... later ...
clearInterval(this.heartbeatHandle);
```

In Effection:

```ts
yield* spawn(function* () {
  while (true) {
    yield* sleep(intervalMs);
    send(heartbeatMessage);
  }
});
// Automatically stopped when parent scope exits
```

Missing heartbeat detection:

```ts
yield* spawn(function* () {
  while (true) {
    let result = yield* race([
      waitForMessage(),
      sleep(deadlineMs).then(() => 'timeout'),
    ]);
    if (result === 'timeout') {
      // Connection is dead, close it
      // This halts the parent scope via error propagation
      throw new Error('heartbeat timeout');
    }
  }
});
```

## What Remains Unchanged

### Public API Surfaces

The following are **not changing** in this migration:

1. **Service/Procedure Schema API**: `createServiceSchema()`, `Procedure.rpc()`,
   `Procedure.stream()`, etc. remain identical.
2. **Client API**: `createClient()` returns the same proxy-based interface.
   `client.service.proc.rpc()` still returns `Promise<Result<T, E>>`.
3. **Server API**: `createServer()` still takes a transport, services map,
   and options.
4. **Result types**: `Ok()`, `Err()`, `Result<T, E>` are pure data — no
   concurrency involvement.
5. **Error schemas**: `BaseErrorSchemaType`, error codes, etc.
6. **Codec interface**: `Codec.toBuffer()` / `Codec.fromBuffer()` are pure
   functions.
7. **Message protocol**: Wire format, control flags, sequence numbers all
   remain the same.

### Impedance Mismatch at Boundaries

The public API is Promise-based (`async/await`). The internals will be
Operation-based (`function*/yield*`). At the boundary:

- **Server entry**: Transport receives a message → enters Effection world
  via `scope.run()` or `Signal.send()` to inject the message into the
  Effection-managed stream.
- **Client exit**: Client procedure calls return `Promise`. Internally,
  the Effection operation is bridged back to a Promise via the `Task`
  (which is both an Operation and a Promise).
- **Handler context**: Procedure handlers are still `async` functions. The
  server wraps them with `call()` to enter the Effection world.

This impedance mismatch is navigable and temporary — once the internals
are solid, the public API can optionally expose Effection-native alternatives.

## The Streams Question

The `Readable`/`Writable` interfaces are worth special attention. They are
part of the public API, but their implementation is deeply intertwined with
internals. The current implementation is ~400 lines of bespoke async channel
code. Options:

### Option A: Keep Readable/Writable as-is, back by Effection primitives

The `Readable` interface stays. Internally, `ReadableImpl` becomes a thin
wrapper around a `Queue`:

```ts
class ReadableImpl<T, E> implements Readable<T, E> {
  private queue = createQueue<ReadableResult<T, E>>();
  // ... delegate to queue ...
}
```

This preserves backward compatibility perfectly but means we have a
wrapper layer.

### Option B: Replace with Effection Streams (recommended for second pass)

Expose `Stream<Result<T, E>>` and `Channel<T>` directly. This is more
powerful (multiple subscribers, stream operators from @effectionx/stream-helpers,
natural composition with `each()`) but changes the public API.

**Recommendation**: Option A for the first pass, Option B as a follow-up
once the internals are stable and we can evaluate the API change holistically.

## The State Machine Question

The session state machine can be eliminated in the second pass. For the first
pass, it may make sense to keep the state machine but simplify it — remove
the Proxy-based consumption guards (Effection prevents use-after-free
structurally), flatten the class hierarchy, and make state transitions
explicit operations rather than object-to-object morphing.

However, the deeper insight is that **we won't need it at all**. The state
machine exists to answer "what can I do right now?" In Effection, the answer
is encoded in the program counter of the generator function. You don't need
to reify "I'm in the Connecting state" into an object because the code is
literally `yield*`-ed on the connect operation. The state is the code position.

## Design Principles for the Migration

1. **Scope = Lifetime**: Every entity with a lifecycle (transport, session,
   procedure stream, heartbeat) becomes a resource or spawned task whose
   lifetime is tied to a scope.

2. **Streams, not Events**: Replace EventDispatcher pub/sub with Effection
   Streams/Channels/Signals. Messages flow through typed channels, not
   untyped event dispatchers.

3. **Structured Error Propagation**: An error in a child operation propagates
   to the parent, which halts siblings. No manual error forwarding. No
   `onHandlerError` callbacks.

4. **No Manual Cleanup**: If you're writing `clearTimeout`, `removeEventListener`,
   or `controller.abort()`, something is wrong. Use `ensure()`, `useAbortSignal()`,
   or let scope exit handle it.

5. **Code Position = State**: Don't reify state into objects when the generator's
   suspension point already encodes the state.

6. **Preserve Semantics, Not Mechanisms**: The *behavior* of reconnection,
   heartbeats, and grace periods must be preserved. The *mechanism* (state
   machine, setTimeout, EventDispatcher) is an implementation detail that
   should change to match the new execution model.
