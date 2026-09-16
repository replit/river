# P model of the River transport/session layer

This directory holds a formal model of River's session layer — the seq/ack
exactly-once bookkeeping, send-buffer retransmission, the 4-case handshake,
transparent vs hard reconnects, session grace periods, the heartbeat watchdog,
and the rehandshake (credential refresh) exchange — written in the
[P language](https://p-org.github.io/P/) and explored with the P model
checker. The checker systematically explores interleavings of the client, the
server, and a fault-injecting WebSocket model, checking the invariants that
`PROTOCOL.md` promises and that `__tests__/properties/README.md` samples with
random fault schedules.

## Running

```
nix develop .#verification   # p (P CLI from NuGet), .NET SDK, uclid + z3
                             # (PVerifier proofs), JDK 17 + maven (PEx)
verification/p/check.sh      # compile + run every scenario + the inductive
                             # proof (~10 minutes)
```

or `npm run model:check`. This is intentionally not wired into `npm test`/CI.
Everything is packaged natively in Nix (see `flake.nix`: the `p` dotnet tool,
and UCLID5 built from a pinned master commit with the z3 4.12 Java bindings —
the released uclid 0.9.5 predates the `datatype` syntax PVerifier emits).

`p check -tc <test> -s <schedules>` runs one scenario; counterexample traces
land in `PCheckerOutput/BugFinding/`. `p check --list-tests` lists scenarios.
`p check --mode pex` (after `p compile --mode pex`) runs the exhaustive
JVM-based explorer instead of randomized bugfinding.

## What is modeled

| P machine                            | Mirrors                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClientTransport` (`PSrc/Client.p`)  | the client session state machine (`transport/sessionStateMachine/`): Idle → Connecting → Handshaking → Connected (+ Dead, Done). Carries sessionId/seq/ack/seqSent/sendBuffer across reconnects; absolute-deadline grace period; retry budget; fresh-session-on-retriable-rejection.                                                                 |
| `ServerTransport` (`PSrc/Server.p`)  | `transport/server.ts`: the 4 handshake connect cases (transparent reconnect with both "in the future" rejections, hard reconnect, unknown session, new session), grace, restart (total state loss), active heartbeats, server-initiated rehandshake with async validate.                                                                             |
| `WsConnection` (`PSrc/Network.p`)    | one machine per WebSocket connection. P's per-machine-pair FIFO gives in-order reliable delivery within a connection for free; distinct connections race naturally (old connection's frames arriving around a new handshake). Faults: drop notifying both/one/neither side; the unnotified side is eventually unstuck by the watchdog (untimed C9b). |
| `Orchestrator` (`PTst/Testscript.p`) | the test driver: issues N calls (the server echoes each accepted payload — a stand-in for an rpc response), injects budgeted drops/restarts/heartbeats/rehandshakes at nondeterministic points, shuts down once every call resolved.                                                                                                                 |

Abstractions: payloads are unique monotonic ints; codecs/serialization are out
of scope (covered by the A-series property tests); all durations are
nondeterministic orderings (timers fire via generation-guarded events with
budgeted defers, so both early and late firings are explored). The stream
layer is a thin overlay: payloads are assigned to streams in blocks of
`streamWidth`, the first message of a stream carries the StreamOpenBit, the
last carries the sender's half-close, and both endpoints keep per-stream
lifecycle records that live exactly as long as the session.

Modeled bit-exactly: the three-way seq/ack receive comparison (`< ack` drop
duplicate, `> ack` invariant-violation/close-connection, `== ack` accept with
`ack = seq+1` and buffer filter `>= msg.ack`), byte-identical replay (a
replayed message carries its original, possibly stale ack), `seqSent`
send-ordering, `expectedSessionState` comparison, heartbeats consuming seqs,
and the consumed-session-state (linear handle) discipline around the
rehandshake's async gaps.

## Properties

| Check                                                                                            | Property catalog                | How                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| inline asserts (`assertBufferWindow`, send-ordering, `seq > ack` unreachable among honest peers) | C2, C3, C4                      | the model self-checks on every send/accept/replay, mirroring the TS `invariant-violation` log oracle                                                                                                        |
| `ExactlyOnceInOrder` (`PSpec/Delivery.p`)                                                        | C1                              | between session resets — hence across any schedule of transparent reconnects — each side accepts payloads exactly once, in order                                                                            |
| `AllCallsResolve` (`PSpec/Delivery.p`)                                                           | C5 + liveness                   | every issued call resolves exactly once (value or `UNEXPECTED_DISCONNECT`); hot state ⇒ an execution that quiesces with a hanging call is a bug                                                             |
| `SessionIdPreserved` (`PSpec/Reconnect.p`)                                                       | C6                              | transparent reconnect keeps the session id                                                                                                                                                                  |
| `CleanShutdown` (`PSpec/Reconnect.p`)                                                            | C7                              | after shutdown starts, both endpoints eventually close                                                                                                                                                      |
| watchdog detection (deferred close to unnotified sides)                                          | C9b (untimed)                   | phantom/one-sided drops must not hang the system; mutation M5 (watchdog disabled) makes `tcPhantom` fail with a liveness bug                                                                                |
| stream lifecycle inline asserts (`trackRequestStream`, `trackResponseStream`)                    | B-series                        | open-exactly-once per stream instance, no data before open, no writes after the writer's half-close on either side; server may keep writing after the CLIENT's half-close (that is the point of half-close) |
| d7c0ec9 inline assert (`PSrc/Server.p`)                                                          | consumed-handle race            | see below                                                                                                                                                                                                   |
| `verified/SessionReconnect.p` inductive proof                                                    | C1/C2/C3 + reconnect, unbounded | see below                                                                                                                                                                                                   |

C9a (a live peer is never falsely killed by elapsed time) is a wall-clock
property outside an untimed model.

## Scenarios

| Test                  | Faults                                           | Notes                                                                          |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `tcHappyPath`         | none                                             | seq/ack + handshake + heartbeat sanity                                         |
| `tcDrops`             | ≤3 drops (both/client-only)                      | the core transparent-reconnect test                                            |
| `tcRestart`           | 1 server restart + ≤1 drop                       | hard reconnect, unknown-session rejection, `UNEXPECTED_DISCONNECT`             |
| `tcByzantine`         | misbehaving client injects duplicate/future seqs | duplicates silently dropped; future seq closes the connection, not the session |
| `tcPhantom`           | ≤2 drops incl. server-only/silent                | watchdog-driven recovery                                                       |
| `tcRehandshake`       | ≤2 credential refreshes racing ≤2 drops          | fixed (post-d7c0ec9) teardown guard: green                                     |
| `tcD7c0ec9Regression` | same, PRE-fix teardown                           | **must find a bug**: `check.sh` asserts the checker reproduces the crash       |

## Findings

1. **Duplicate delivery across server-side session loss in the zero-state
   window — found by the model, confirmed against the implementation, and
   FIXED.** If the server accepts messages but every ack/echo back to the
   client is lost, and the server then loses the session (grace expiry or
   restart) before the client reconnects, the client's handshake presents
   `nextSentSeq = 0, nextExpectedSeq = 0` — indistinguishable from a new
   session. The server accepted it (connect case 4), the client believed the
   reconnect was transparent and replayed its buffer, and server handlers
   executed the same requests a second time while the original calls hung
   forever. `__tests__/zerostate.test.ts` reproduced this deterministically
   against the TypeScript implementation. The fix: the client marks
   reconnection attempts with `expectedSessionState.isReconnect` (an
   optional, wire-compatible field — the session tracks `hadConnection`
   across transitions), and the server rejects a marked reconnect to a
   session it does not have with `SESSION_STATE_MISMATCH`, yielding the
   documented hard-reconnect semantics (`UNEXPECTED_DISCONNECT`, fresh
   session, no replay). With the fix, the `ExactlyOnceInOrder` monitor is
   strengthened: the delivery watermark may only move FORWARD across session
   resets (gaps allowed, re-delivery never), and all scenarios pass; the
   pre-fix protocol lives on behind `zeroStateGuardFixed = false` as the
   `tcZeroStateDup` regression, which `check.sh` requires the checker to
   flag.

2. **The d7c0ec9 consumed-handle race reproduces.** The model gives the
   server's Connected state an instance epoch (the TS linear-typed state
   proxy) and models the rehandshake's async `validate()` as a deferred
   completion carrying the captured epoch. With the pre-fix teardown (reads
   `session.to` before checking `_isConsumed`), the checker finds the crash:
   a rehandshake rejection completing after a connection drop consumed the
   state instance. With the fixed guard it is silent, and cleanup falls to
   the replacement session — the model-level regression test for that bug
   class.

## The inductive proof (`verified/SessionReconnect.p`)

The bounded scenarios above sample schedules; the proof covers unbounded
executions — and it covers the part of the protocol where the real bug
lived. `verified/SessionReconnect.p` models the delivery core (consecutive
seq assignment, retransmission from the unacked window, cumulative acks, the
`seq == ack` gate) PLUS sessions, total server state loss, hard client
resets, and the handshake with the `isReconnect` guard, over PVerifier's
network abstraction (arbitrary drop/duplication/reordering — strictly more
hostile than WebSocket connections, so the result holds a fortiori).

`p compile -pf SessionReconnect.p -pn RiverSessionReconnect -md verification`
discharges 40 obligations with UCLID5 + Z3. **The theorem: across any
schedule of server restarts, session grace expiries, client hard resets,
replays, and reconnect handshakes, the application-level delivered stream
never regresses — no payload is ever delivered twice — and deliveries within
one session are gap-free.** The proof's load-bearing chain is the fix
itself: data only exists for sessions that were granted a handshake
(`msgs_granted`), a fresh (isReconnect=false) handshake is unique per
session and only in flight for never-granted sessions (`fresh_unique`,
`fresh_not_granted`), so accepting a session as NEW is safe, and every
deliverable in-flight message stays above the delivery watermark
(`deliverable_above_watermark`). Removing the `isReconnect` guard from the
model makes exactly that chain fail induction (mutation P2), and letting the
receiver accept `seq <= ack` breaks the window obligations (mutation P1) —
the proof is load-bearing on both the fix and the seq/ack gate.

Model/implementation correspondence: the proved guards match the shipped code
line for line — the server's unknown-session rejection
(`clientNextSentSeq > 0 || isReconnect === true`, transport/server.ts), the
client-in-future check, fresh-session-on-retriable-rejection
(transport/client.ts), `hadConnection` set on entering Connected
(transitions.ts), cumulative-ack buffer pruning, and byte-identical
retransmission. Deliberate abstractions: data flows one direction (the
reverse direction holds by symmetry but is not separately machine-checked);
acks are standalone events rather than piggybacked (a superset of real
schedules); messages are composed at transmit time (the TS unsent-buffer is
invisible on the wire, so reachable wire states coincide); session tags on
wire events stand in for connection binding; and a session gets one fresh
handshake attempt (TS retries the same session, which is safe because
handshakes are connection-scoped — a requirement the proof surfaced and
PROTOCOL.md now states).

Modeling notes: PVerifier's network has no connections, so the model folds
"a handshake request dies with its connection" into
one-fresh-attempt-per-session (a never-connected session retries by
resetting, which reaches the same states up to session renumbering); the
`granted` ghost set on the server is proof bookkeeping and persists across
modeled restarts. PVerifier subset notes: `choose()` and `$` inside compound
conditions are unsupported; proof commands must form a DAG (mutually
dependent invariants live in one `Lemma` group); the P CLI invokes
`uclid -M` (auto-inferred modifies sets).

## Runtime conformance (PObserve)

The model checker and the proof explore the _model_; PObserve closes the loop
by checking the _implementation_: `observe.sh` (or `npm run model:observe`)
runs the hegel property-based suite with execution tracing and replays the
traces through P spec machines — the same specification language as the
model, checked against reality.

- **Trace tap** (`testUtil/fixtures/trace.ts`, activated by
  `RIVER_TRACE_DIR`, zero library changes): a wrapper codec records every
  outbound frame at encode time, `bindLogger` records every accepted inbound
  frame (the `received msg` debug line carries seq/ack/streamId/sessionId)
  plus out-of-order receives and `invariant-violation` lines, and the
  transport events record session lifecycle. One JSONL file per generated
  test case, ordered by a process-monotonic counter.
- **Specs** (`PObs/RiverTraceSpecs.p`, compiled with
  `p compile --mode pobserve`): PObserve partitions the event stream per key
  and runs one monitor instance per partition, so "per session" and "per
  stream" scoping falls out of key choice (`observe.sh` runs one PObserve
  pass per spec):

  | Spec                      | Partition              | Mirrors                                                                                    |
  | ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
  | `AcceptedSeqContiguous`   | session, receiver side | C1/C2: accepted seqs are exactly 0,1,2,... within a session, across transparent reconnects |
  | `EncodedSeqDense`         | run, sender side       | assertSendOrdering's shadow: dense seq assignment                                          |
  | `SessionStateConformance` | side, session          | real `sessionTransition` events follow the model's state graph exactly                     |
  | `StreamFlagDiscipline`    | session, stream, side  | B-series: open-exactly-once, nothing after the sender's close                              |
  | `NoInvariantViolations`   | global                 | C4 + out-of-order receives never happen over reliable connections                          |

- **Parser** (`PObs/parser/RiverTraceParser.kt`, Kotlin): JSONL → typed P
  events; mode-selected via `--parserConfiguration`. Built by `observe.sh`
  (kotlinc from the dev shell, stdlib bundled via `-include-runtime`) against
  the Nix-packaged PObserve runtime (`packages.<system>.pobserve`, compiled
  from the P repo's plain-Java sources with pinned Maven jars — the
  artifacts are not on Maven Central). The port was verified equivalent to
  the original Java parser: both run over the same 193-file trace corpus
  with identical per-spec event/key/partition counts and identical
  violation reports on poisoned traces.

Current status: **all five specs pass** over the full property suite
(~7,000 records, ~380 sessions, ~480 streams per run). Detection was
validated with a poisoned trace (a seq gap makes `AcceptedSeqContiguous`
report the exact partition and assertion, with a replay window of the
preceding events) — and by a harness bug the pipeline caught during
bring-up: partition keys initially spanned test processes, and
`EncodedSeqDense` flagged the interleaving immediately.

## Mutation validation

Monitors were validated by seeding bugs and confirming detection
(re-run by hand; each mutation is a one-line change):

| Mutation                                                                        | Detected by                                                                                                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| M1: buffer filter prunes `<= ack` instead of `< ack` (drops an unacked message) | `assertBufferWindow`                                                                                                                            |
| M2: skip send-buffer replay on reconnect                                        | `AllCallsResolve` liveness (calls hang)                                                                                                         |
| M3: duplicates reach the handler instead of being dropped                       | `ExactlyOnceInOrder` (needs `--sch-feedback`)                                                                                                   |
| M4: transparent adopt forgets the inherited ack                                 | `ExactlyOnceInOrder` (needs `--sch-feedback`)                                                                                                   |
| M5: watchdog disabled                                                           | `AllCallsResolve` liveness in `tcPhantom`                                                                                                       |
| M6: stale per-stream records kept across a new server session                   | NOT detected within 100k schedules — reaching it needs the rare zero-state hard-reconnect window; the stream asserts remain as defense-in-depth |
| P1 (proof): receiver accepts `seq <= ack`                                       | 3 PVerifier obligations fail                                                                                                                    |

Because M3/M4 were only found by the feedback scheduler, `check.sh` runs every
scenario under both the random and feedback strategies.

## Model-design notes

- **Timers**: generation-guarded fire events echoed by an `EchoTimer` machine,
  with budgeted nondeterministic defers. This is the official P Timer idiom
  (Tutorial/Common models a timer as a nondeterministic-delay self-loop) with
  a bounded defer count instead of a probabilistic unbounded loop, and
  generation guards instead of cancel messages (they encode the TS
  absolute-deadline grace semantics directly). A naive immediate echo lands
  the grace fire early in the owner's FIFO queue in most schedules, starving
  the post-Connected part of the state space (this starvation was discovered
  by reachability probes: transparent reconnect was unreachable before the
  defer pattern).
- **Fault timing**: the injector decides to drop a connection when it is
  created; the drop event's budgeted defers move the actual drop point across
  the connection's message stream — the same shape as the hegel
  write-schedule generator's `null` fault points.
- **Known model/TS divergences** (intentional): backoff durations, connect and
  handshake timeouts are collapsed into the nondeterministic scheduler; server
  restart does not kill in-flight handshake requests (equivalent to a fast
  reconnect); retry-budget exhaustion is terminal (`Dead`) rather than
  time-restored.

## Roadmap

- StreamCancelBit (abrupt full-close) and cancel races in the stream overlay.
- A parameterized test sweep (`test param (dropBudget in [...], ...)`) to
  replace the per-scenario Main machines.
- PEx exhaustive runs of the smaller scenarios as a nightly job.
- Extending the proof toward multi-message transparent adoption detail
  (inherited nonzero seq/ack windows across adoption are currently exercised
  by the checker; the proof models adoption at the handshake level).
