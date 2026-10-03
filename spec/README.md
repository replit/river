# River protocol model

[`river.qnt`](./river.qnt) is an executable model of [PROTOCOL.md](../PROTOCOL.md), written in [Quint](https://quint-lang.org). The test suite replays the model's traces against the TypeScript implementation and compares the two after every step, so any disagreement means one of them is wrong.

- `river.qnt`: the model's state, transitions, `step` actions, invariants, and witnesses
- `river_test.qnt`: scenarios, one per protocol behavior or known bug
- [`__tests__/conformance`](../__tests__/conformance): the harness that replays traces against the implementation

## What it models

One client and one server carry up to three procedures of any kind (rpc, stream, upload, subscription) over connections that can lose frames, garble them, or break:

- connecting: backoff, connection and handshake timeouts, and the client and server session state machines
- the handshake: transparent reconnects, hard reconnects, and each reason the server rejects a session
- sequencing: seq/ack, the send buffer, retransmission on reconnect, and duplicate and out-of-order detection
- the grace period, heartbeats, and the phantom-disconnect watchdog
- stream lifecycles: writes, half-closes, cancellation from either side, handler errors, and teardown when a session ends
- faults: frame loss, undecodable frames, broken connections whose close events reach each side at different times, failed dials, server restarts, `ServerTransport.close()`, and `hardDisconnect()`

Codecs, version negotiation, handshake metadata, re-handshaking, and multiple clients are out of scope. Frames on a connection arrive in order or not at all, which is what River's transports guarantee. Timers are explicit deadlines, and time moves only when a timer fires or `tickBy` advances it.

## Invariants

`safety` combines the invariants below, and every simulated state is checked against it.

| Invariant                 | Holds when                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `exactlyOnceInOrder`      | each side of a stream has received a prefix of what the other side wrote, with nothing duplicated |
| `noCrossSession`          | a session never processes a message sent by another session                                       |
| `noAckBeyondSent`         | no ack covers a message the peer never sent                                                       |
| `sendOrdering`            | the implementation's send-ordering assertion never trips                                          |
| `bufferHoldsUnacked`      | while both sides share a session, every unacknowledged message is still in its sender's buffer    |
| `acksBounded`             | neither side acknowledges more than the other has sent                                            |
| `noNeedlessRejection`     | a reconnect to a session the server still holds is never rejected for mismatched sequence numbers |
| `graceWhileDisconnected`  | a disconnected session always has its grace timer running                                         |
| `watchdogWhileConnected`  | a live connection always has a watchdog                                                           |
| `teardownResolvesStreams` | when a session ends, every stream it carried is resolved on both sides                            |
| `closeIsFinal`            | after a side closes a stream, it sends nothing more on it except a cancel                         |
| `closedServerIsEmpty`     | a closed server transport holds no sessions and no pending handshakes                             |

`cancelIsFinal` (nothing is sent on a stream after its cancel arrives) is kept out of `safety` because the implementation breaks it; see [Known bugs](#known-bugs). The `w*` values are witnesses: `quint run --witnesses wTransparentReconnect wServerRestarted ...` reports how many traces reach each one, which shows whether simulation actually exercises a path.

## Running it

| Command                  | What it does                                                    |
| ------------------------ | --------------------------------------------------------------- |
| `npm run spec:typecheck` | typecheck the model and its scenarios                           |
| `npm run spec:test`      | run the scenarios in `river_test.qnt`                           |
| `npm run spec:check`     | simulate 2,000 random traces of 80 steps and check `safety`     |
| `npm test`               | includes the conformance suite                                  |
| `npm run spec:hunt`      | replay 2,000 random traces of 80 steps from a fresh random seed |

`spec:check` and `spec:hunt` use Quint's Rust simulator, which downloads a binary the first time it runs. Everything in `npm test` uses the TypeScript simulator, so it needs nothing beyond `node_modules`.

## Conformance

The suite in `__tests__/conformance` replays model traces against a real `ClientTransport`, `ServerTransport`, router, and client:

1. `quint run` generates random traces of the weighted `step` action, checking `safety` on every state along the way, and `quint test` produces one trace per scenario.
2. The harness performs each step against the implementation. A scripted in-memory network (`network.ts`) holds frames until the trace delivers, drops, or garbles them. A fake clock from `@sinonjs/fake-timers` advances only when the trace fires a timer or advances time, and timers due at the same moment fire one per step in scheduling order, as in the model.
3. After each step, both sides are projected onto the same observable state: session states, seq/ack, send buffers, frames in flight, stream states, delivered values, protocol errors, and the number of pending timers. The first difference fails the test with a diff and the steps that led to it.

The suite runs every scenario, checks that each known bug still reproduces, and replays 100 random traces of 60 steps. Environment variables tune the random part:

| Variable        | Default      | Meaning                                                      |
| --------------- | ------------ | ------------------------------------------------------------ |
| `QUINT_SEED`    | `0x5eed`     | seed for the random traces; `random` picks one and prints it |
| `QUINT_TRACES`  | `100`        | number of random traces                                      |
| `QUINT_STEPS`   | `60`         | steps per trace                                              |
| `QUINT_BACKEND` | `typescript` | `rust` is faster but downloads a binary                      |
| `QUINT_VERBOSE` | unset        | print how each trace ended                                   |

### When conformance fails

Rerun with the printed seed to reproduce, then decide which side is wrong:

- If the implementation's behavior is intended or PROTOCOL.md allows it, fix the model.
- If the implementation breaks the protocol, add a scenario that reproduces the bug to `river_test.qnt` and an entry to `KNOWN_BUGS` in `conformance.test.ts`. Random traces then stop just before the bug's trigger, so they keep finding other divergences. Once the bug is fixed, its scenario stops reproducing, and the suite fails until the entry is removed.

## Known bugs

- **`invalid-handshake-response`** (`invalidHandshakeResponseTest`): an undecodable handshake response makes `ClientTransport` throw from the connection's data listener instead of tearing the session down, because `onInvalidHandshake` deletes the `SessionConnecting` state that the handshake already consumed. No protocol error is emitted, and the session stays in `Handshaking` until the handshake timeout.
- **`server-close-keeps-pending-handshakes`** (`serverCloseDuringHandshakeTest`): `ServerTransport.close()` leaves connections that are still handshaking open. If one of those handshakes completes, the closed transport creates a session that keeps sending heartbeats while dropping every message, so the client stays connected and its calls are never answered.
- **`cancelIsFinal`** (`serverClosesAfterClientCancelTest`): the server answers a client's cancel of a stream or subscription with a `ControlClose`, although a cancel is an immediate full close. The model follows the implementation here so the conformance suite stays green, and `quint run spec/river.qnt --invariant cancelIsFinal` finds the violation in seconds.

Exactly-once delivery holds within a server process, not across restarts (`serverRestartBeforeFirstReplyReplaysTest`). If the server restarts before the client hears anything from it, the client's reconnect looks like a brand-new session because both sequence numbers are still 0. The new server accepts it, and the replayed call runs a second time.

## Limits

- `quint run` samples traces; it does not prove the invariants. Bounded model checking with Apalache (`quint verify`) does not currently work, because Quint's JSON encoding of this model exceeds Apalache's 20 MB input limit.
- The configuration is small: three streams with up to two writes each. Timer durations are distinct primes (backoff 23, heartbeat 97, connection timeout 113, handshake timeout 139, grace 401) so that different kinds of timer rarely land on the same instant, and the harness passes the same values to the implementation.
