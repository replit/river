# River → Effection Migration Plan

## Module Dependency Chain

```
codec/          (no internal deps)         ← LEAF
logging/        (imports transport/message types only)  ← LEAF (type-only dep)
tracing/        (imports router, transport, logging types) ← LEAF (type-only deps)
transport/      (imports logging, tracing, codec)
  ├─ message.ts, events.ts, connection.ts  ← LEAF (no Effection changes needed)
  ├─ transport.ts, client.ts, server.ts    ← CORE (major rewrite)
  └─ sessionStateMachine/                  ← DISSOLVES into transport core
router/         (imports transport, logging, tracing, codec)
  ├─ result.ts, errors.ts, context.ts, handshake.ts, procedures.ts, services.ts ← LEAF
  ├─ streams.ts                            ← REWRITE (back with Effection primitives)
  ├─ server.ts                             ← CORE (major rewrite)
  └─ client.ts                             ← CORE (major rewrite)
testUtil/       (imports everything)       ← UPDATE after core changes
```

## Parallelization Strategy

### Phase 0: Foundation (no code changes needed)
- `codec/` — Pure functions, no concurrency. **No changes needed.**
- `logging/` — Pure logging utilities. **No changes needed.**
- `tracing/` — OpenTelemetry wrappers. **No changes needed.**
- `transport/message.ts` — Message schemas, control flags. **No changes needed.**
- `transport/connection.ts` — Abstract connection interface. **No changes needed.**
- `transport/id.ts` — ID generation. **No changes needed.**
- `transport/results.ts` — Result types. **No changes needed.**
- `transport/stringifyError.ts` — Error coercion. **No changes needed.**
- `router/result.ts` — Ok/Err types. **No changes needed.**
- `router/errors.ts` — Error schemas. **No changes needed.**
- `router/context.ts` — Handler context type. **No changes needed.**
- `router/handshake.ts` — Handshake option types. **No changes needed.**
- `router/procedures.ts` — Procedure type definitions. **No changes needed.**
- `router/services.ts` — Service schema system. **No changes needed.**

These are all pure types, pure functions, or schemas. Zero concurrency concerns.

### Phase 1: Transport Events → Streams (serialized, foundational)

**Depends on**: Phase 0
**Blocks**: Phase 2, Phase 3

Replace `EventDispatcher` with Effection stream primitives. This is the
foundation everything else builds on.

#### 1a. Install Effection dependencies

```
npm install effection
```

We may add `@effectionx/websocket` and `@effectionx/stream-helpers` later
if needed, but core `effection` is sufficient for the migration.

#### 1b. Rewrite `transport/events.ts`

Replace `EventDispatcher` class with typed Effection signals/channels.
The transport will expose:
- `messages: Signal<OpaqueTransportMessage>` — incoming messages
- `sessionStatus: Signal<SessionStatusEvent>` — session lifecycle events
- `protocolErrors: Signal<ProtocolErrorEvent>` — protocol errors
- `transportStatus: Signal<TransportStatusEvent>` — transport open/closed

`Signal` is correct here (not Channel) because:
- Messages arrive from connection callbacks (sync, outside operations)
- Multiple consumers need independent subscriptions (server routes by streamId)

#### 1c. Rewrite `transport/transport.ts`

The base `Transport` class becomes a resource. Key changes:
- `sessions` map remains
- `addEventListener`/`removeEventListener` → streams from 1b
- `handleMsg` → `messages.send(msg)`
- `protocolError` → `protocolErrors.send(err)`
- `close()` → scope exit handles cleanup
- `createSession`/`updateSession`/`deleteSession` → simplified, no event dispatch
  (session lifecycle is encoded in scope lifetime)

The `getSessionBoundSendFn` pattern needs rethinking. In Effection, a
session-bound send is just calling send on a session resource that's alive
within its scope. If the scope is dead, the operation that would call send
has already been halted.

### Phase 2: Session State Machine → Resource (serialized, depends on Phase 1)

**Depends on**: Phase 1
**Blocks**: Phase 3

This is the biggest single change. The entire `sessionStateMachine/` directory
dissolves into the transport client/server implementations.

#### 2a. Client Session as Resource

```ts
function* useClientSession(transport, to, options): Operation<SessionResource> {
  return yield* resource(function* (provide) {
    let sendBuffer: EncodedTransportMessage[] = [];
    let seq = 0, ack = 0;
    let sessionId = generateId();
    let telemetry = createSessionTelemetryInfo(...);

    yield* ensure(() => { telemetry.span.end() });

    // The reconnection loop
    let retries = 0;
    while (true) {
      try {
        // Backoff
        if (retries > 0) {
          yield* sleep(backoff(retries, options));
        }

        // Connect with timeout
        let conn = yield* race([
          createConnection(to),
          sleep(options.connectionTimeoutMs).then(() => {
            throw new Error('connection timeout');
          }),
        ]);

        // Handshake with timeout
        let handshakeResult = yield* race([
          performHandshake(conn, sessionId, seq, ack),
          sleep(options.handshakeTimeoutMs).then(() => {
            throw new Error('handshake timeout');
          }),
        ]);

        retries = 0;

        // Connected! Provide the session resource
        yield* scoped(function* () {
          // Send buffered messages
          for (let msg of sendBuffer) { conn.send(msg) }

          // Spawn heartbeat
          yield* spawn(function* () {
            while (true) {
              yield* sleep(options.heartbeatIntervalMs);
              sendAck(conn, seq, ack);
            }
          });

          // Spawn heartbeat monitor
          yield* spawn(function* () {
            // ... race between messages and timeout
          });

          // Provide session capabilities
          yield* provide({
            send: (msg) => { /* encode, buffer, send */ },
            messages: incomingMessageStream,
            id: sessionId,
            to, from: transport.clientId,
          });
        });

        // If provide returns (scope exited cleanly), we're done
        break;
      } catch (e) {
        retries++;
        if (retries > options.maxRetries) throw e;
        // Loop back to retry
      }
    }
  });
}
```

#### 2b. Server Session Handling

Server sessions are simpler — no reconnection loop. On connection:

```ts
function* handleIncomingConnection(conn, transport) {
  // Wait for handshake with timeout
  let handshake = yield* race([
    waitForHandshakeRequest(conn),
    sleep(options.handshakeTimeoutMs).then(() => {
      throw new Error('handshake timeout');
    }),
  ]);

  // Validate handshake (protocol version, metadata, etc.)
  let validation = yield* validateHandshake(handshake, ...);

  // Handle transparent reconnect vs new session vs hard reconnect
  // ... (the 4 cases from current server.ts)

  // Send handshake response
  sendHandshakeResponse(conn, ...);

  // Spawn connected session as resource
  yield* spawn(function* () {
    // ... heartbeat, message routing, etc.
  });
}
```

#### 2c. Delete `sessionStateMachine/` directory

After 2a and 2b, the following files are no longer needed:
- `sessionStateMachine/common.ts`
- `sessionStateMachine/transitions.ts`
- `sessionStateMachine/SessionNoConnection.ts`
- `sessionStateMachine/SessionBackingOff.ts`
- `sessionStateMachine/SessionConnecting.ts`
- `sessionStateMachine/SessionHandshaking.ts`
- `sessionStateMachine/SessionConnected.ts`
- `sessionStateMachine/SessionWaitingForHandshake.ts`

#### 2d. Rewrite `transport/rateLimit.ts`

The `LeakyBucketRateLimit` can stay mostly as-is (it's pure logic), but its
timer-based budget restoration should use `spawn` + `sleep` instead of
`setInterval`.

### Phase 3: Router Layer (parallelizable server + client)

**Depends on**: Phase 2
**Can parallelize**: 3a and 3b are independent

#### 3a. Rewrite `router/streams.ts`

Replace `ReadableImpl`/`WritableImpl` internals with Effection primitives.
Keep the `Readable<T, E>` and `Writable<T>` interfaces unchanged.

```ts
// ReadableImpl backed by Queue
class ReadableImpl<T, E> implements Readable<T, E> {
  private queue = createQueue<ReadableResult<T, E>>();
  private closed = false;
  private broken = false;
  private locked = false;

  [Symbol.asyncIterator](): ReadableIterator<T, E> {
    // Delegate to queue, wrapping in async iterator protocol
  }

  _pushValue(value) { this.queue.add(value); }
  _triggerClose() { this.closed = true; /* close queue */ }
  break() { this.broken = true; /* ... */ }
}
```

**Important**: The `Readable` interface returns `Promise` from its async
iterator. Since this is a public API boundary, we bridge Effection's
`Queue` back to promises here. This is the impedance mismatch point.

#### 3b. Rewrite `router/server.ts`

The server's `createNewProcStream` becomes a spawned operation:

```ts
// Instead of manual cleanup orchestration:
yield* spawn(function* () {
  let signal = yield* useAbortSignal();
  yield* ensure(() => { streams.delete(streamId) });

  let reqQueue = createQueue();
  let resChannel = createChannel();

  // Spawn response sender
  yield* spawn(function* () {
    for (let result of yield* each(resChannel)) {
      sessionSend({ streamId, payload: result, ... });
      yield* each.next();
    }
  });

  // Run handler (bridge async handler into Effection)
  yield* call(() => procedure.handler({
    ctx: { ...serviceContext, signal, ... },
    reqInit: initPayload,
    reqReadable: reqQueue,
    resWritable: resChannel,
  }));
});
```

The message routing (`handleCreatingNewStreams`) becomes a stream consumer
instead of an event listener:

```ts
for (let msg of yield* each(transport.messages)) {
  let stream = streams.get(msg.streamId);
  if (stream) {
    stream.handleMsg(msg);
  } else {
    // validate and create new proc stream
    yield* spawn(function* () {
      yield* createNewProcStream(msg, ...);
    });
  }
  yield* each.next();
}
```

#### 3c. Rewrite `router/client.ts`

The `handleProc` function becomes an Effection operation bridged to Promise:

```ts
function handleProc(procType, transport, serverId, init, ...): AnyProcReturn {
  // We need to bridge from Promise-land (public API) to Effection-land (internals)
  // The transport's scope runs the operation; the Promise observes the result

  // For RPC: the operation sends the request, waits for response, returns Result
  // For streaming: sets up the streams and returns handles immediately
}
```

The key insight: `handleProc` currently does everything synchronously
(sets up listeners, sends init message, returns immediately with readable/writable
handles). This pattern can stay — the Effection operation is spawned into
the transport's scope, and the Promise/stream handles are returned to the caller.

### Phase 4: Transport Implementations (parallelizable)

**Depends on**: Phase 2
**Can parallelize**: WS client and WS server are independent

**Note**: `tsup.config.ts` references UDS transport entry points
(`transport/impls/uds/client.ts`, `transport/impls/uds/server.ts`) that
**do not exist on disk**. Remove these from the build config before
starting the migration.

#### 4a. Rewrite `transport/impls/ws/client.ts`

`WebSocketClientTransport` becomes a resource that extends the base transport
resource pattern. Wrap the existing WebSocket creation in an `action()`.

#### 4b. Rewrite `transport/impls/ws/server.ts`

`WebSocketServerTransport` wraps the HTTP server's upgrade events as a
stream and spawns connection handlers.

#### 4c. `transport/impls/ws/connection.ts`

`WebSocketConnection` may stay mostly unchanged — it's a thin wrapper
around the WebSocket API. However, its listener-based callbacks can be
replaced with Effection's `on()`/`once()` for event bridging.

### Phase 5: Test Utilities

**Depends on**: Phase 3, Phase 4

#### 5a. Update `testUtil/fixtures/transports.ts`

Mock transport needs to work with the new resource-based transport API.

#### 5b. Update `testUtil/fixtures/mockTransport.ts`

`InMemoryConnection` and `createMockTransportNetwork` need to provide
Effection-compatible interfaces.

#### 5c. Update test helpers

`waitForMessage`, `closeAllConnections`, etc. need to work with streams
instead of event listeners.

### Phase 6: Test Suite

**Depends on**: Phase 5

Run the full test suite. Fix failures. The tests themselves should mostly
not change (they test behavior, not implementation), but some tests that
directly poke at transport internals will need updating.

## Important Notes to Remember

### 1. The Impedance Mismatch

The public API is Promise-based. Internally we use Operations. At every
boundary point (client procedure calls, server handler invocation, transport
creation), we need a bridge:

- **Effection → Promise**: `Task` is both an Operation and a Promise. Or use
  `run()` to get a Task from an Operation.
- **Promise → Effection**: `call(() => promise)` or `until(promise)` adapts
  a Promise into an Operation.
- **Sync callbacks → Effection**: `Signal.send()` bridges synchronous
  callbacks (WebSocket events) into Effection streams.
- **Effection → Sync callbacks**: `useScope()` captures the current scope
  so you can call `scope.run()` from callbacks.

### 2. Who Owns the Effection Scope?

The top-level scope must live somewhere. Options:

- **Transport owns it**: `createServer()`/`createClient()` internally calls
  `run()` to create a root scope. The transport resource lives in this scope.
  `close()` destroys the scope.
- **User provides it**: The user wraps their app in `main()` and passes
  the scope to River. This is the "Effection-native" API for the second pass.

For the first pass: **Transport owns it**. `createServer()` calls `run()`
internally, creating a scope that owns all sessions, streams, and heartbeats.
`server.close()` destroys this scope, which tears down everything.

### 3. Sequence Numbers and Send Buffer

The message ordering system (seq/ack/sendBuffer) is pure protocol logic.
It doesn't need Effection. Keep it as data on the session resource. The
*mechanism* of sending buffered messages changes (from state machine
transition callbacks to resource initialization), but the *logic* stays.

### 4. Transparent Reconnection

Transparent reconnection is about session identity surviving connection drops.
In Effection terms: the session resource stays alive (its scope hasn't exited),
but the connection sub-resource within it is replaced. The send buffer and
seq/ack state persist because they're on the session, not the connection.

This means the session resource's reconnection loop needs to be able to
re-provide the same session identity with a new connection without exiting
the resource scope. The `scoped()` operation inside the reconnection loop
handles this — each connection attempt is a child scope that can be torn
down independently.

### 5. v1.1 Backward Compatibility

The v1.1 backward compatibility code (`isStreamCancelBackwardsCompat`,
`isStreamCloseBackwardsCompat`, `passInitAsDataForBackwardsCompat`) is
pure protocol logic. It stays as-is. It has no concurrency implications.

### 6. Test Timing

Tests use `vi.useFakeTimers({ shouldAdvanceTime: true })` in `__tests__/globalSetup.ts`.
Effection's `sleep()` uses `setTimeout` internally, so fake timers should work,
and `shouldAdvanceTime: true` is ideal. But verify this early — if there's
an incompatibility, we need to know before we're deep into the migration.

### 6b. Test Helper Bridging

Test utilities like `waitForMessage()` in `testUtil/index.ts` use
`transport.addEventListener('message', ...)` with manual cleanup. After
Phase 1, these need to be bridged to consume from Effection streams instead.
The bridge pattern: consume the stream in Effection, resolve a Promise
that the test helper returns.

### 7. What to Verify After Each Phase

After Phase 1: `transport/events.test.ts` passes
After Phase 2: `transport/transport.test.ts`, `transport/sessionStateMachine/stateMachine.test.ts` pass
  (state machine tests may need rewriting since the state machine is gone)
After Phase 3: `__tests__/e2e.test.ts` and all integration tests pass
After Phase 4: `transport/impls/ws/ws.test.ts` passes
After Phase 5+6: Full test suite green

### 8. Don't Boil the Ocean

Each phase should produce a working system with passing tests. Don't move
to the next phase until the current phase is green. If a phase is too large,
break it down further.

### 9. The `each.next()` Requirement

When consuming Effection streams with `each()`, you **must** call
`yield* each.next()` at the end of every loop iteration, including when
using `continue`. This is the most common Effection footgun. Be vigilant.

### 10. Operations Are Lazy

`spawn(operation)` returns an Operation, not a Task. You must `yield*` it
to start the work. This is different from `Promise` which starts eagerly.
Every `spawn()` must be `yield*`-ed.

## Estimated Complexity by Phase

| Phase | Files Changed | Lines Changed | Risk |
|-------|--------------|---------------|------|
| 0     | 0            | 0             | None |
| 1     | 2-3          | ~200          | Low  |
| 2     | 10-15        | ~1000         | High |
| 3     | 3            | ~600          | High |
| 4     | 3            | ~200          | Med  |
| 5     | 5            | ~300          | Med  |
| 6     | 15+          | varies        | Med  |
