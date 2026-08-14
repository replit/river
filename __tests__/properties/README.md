# Property-based tests

These tests use [hegel](https://hegel.dev/) (`@hegeldev/hegel`), a Hypothesis-style
property-based testing library. Instead of asserting on hand-picked examples, each
test states an invariant that must hold for _every_ generated input, and hegel
searches for a counterexample and shrinks it to the smallest failing case.

Run them like any other test:

```bash
npx vitest run __tests__/properties
```

To reproduce a specific failure, hegel prints a seed; pass it back via the
`seed` setting on the failing test.

## Why these properties

The properties below are derived from the guarantees [PROTOCOL.md](../../PROTOCOL.md)
makes. They are the things that must stay true as the implementation changes —
the example-based tests in `__tests__/` cover specific scenarios, these cover the
space around them.

### A. Codec round-trips (`codec.property.test.ts`)

A codec's only job is to be a faithful bijection between a `TransportMessage` and
bytes. Everything above it assumes that.

| #   | Property                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | For any valid `TransportMessage` `m`, `fromBuffer(toBuffer(m))` deep-equals `m`.                                                          |
| A2  | Optional fields (`serviceName`, `procedureName`, `tracing`) stay absent after a round-trip rather than being materialized as `''`/`null`. |
| A3  | Every `controlFlags` bit combination survives exactly.                                                                                    |
| A4  | Arbitrary nested payloads (objects, arrays, unicode text, binary, `null`) survive.                                                        |
| A5  | `seq`/`ack` survive across their full supported range.                                                                                    |
| A6  | Encoding is deterministic: `toBuffer(m)` twice yields identical bytes.                                                                    |
| A7  | `fromBuffer` on arbitrary bytes either throws or returns an object — it never returns a non-object and never hangs.                       |
| A8  | `seq`/`ack` outside the wire format's range are either carried exactly or refused at encode time — never silently truncated.              |

Writing A1 surfaced three inputs that were not round-trippable. Two are now
fixed in `NaiveJsonCodec`, which is the default codec:

- **A payload key of `$t` used to decode as binary.** `$t` is the codec's escape
  marker for `Uint8Array`, so an application payload using that key was silently
  decoded as binary — corruption with no error.
- **A payload key of `$b` with a non-numeric value used to throw.** `$b` is the
  marker for `bigint` and the reviver called `BigInt()` unconditionally, so
  `{ $b: 'x' }` made `fromBuffer` throw. A decode failure is treated as an
  invalid message, which tears the connection down — reachable from ordinary
  application data.

Both are fixed by escaping: any key that could be mistaken for a marker gains an
extra `$` on the way out and loses it on the way back in. `NaiveJsonCodec marker
escaping` covers the specific cases and the older-peer compatibility edge.

The third is still open, and the generators are scoped around it:

- **`BinaryCodec` and `ProtoCodec` encode a `__proto__` payload key but cannot
  decode it.** msgpack guards prototype pollution on the way in but not on the
  way out, so these codecs produce bytes they will then reject. `NaiveJsonCodec`
  round-trips it fine, so whether a payload is deliverable depends on which codec
  the transport was configured with. Escaping was cheap for `NaiveJsonCodec`
  (~1.6%, since `JSON.stringify`'s replacer already visits every property);
  msgpack exposes no equivalent hook, so the same fix there means a second full
  traversal of every payload on encode.

A8 checks the boundary where `TransportMessageSchema` (an unbounded
`Type.Integer()`) and ProtoCodec's envelope (`uint32`) disagree about what is
representable. The good news is that the disagreement is loud: `NaiveJsonCodec`
and `BinaryCodec` carry any safe integer exactly, and ProtoCodec **throws** on an
out-of-range or negative `seq` rather than wrapping it. `CodecMessageAdapter`
catches that and turns it into a send failure, which tears the session down with
a reason — so a peer never has to reason about a truncated `seq`.

One narrower asymmetry is pinned the same way: `ProtoCodec` decodes an
empty-string `serviceName`/`procedureName` back as absent (its envelope uses `''`
as the absent sentinel), and its envelope types `seq`/`ack` as `uint32`, so those
fields have a lower ceiling there than the `Type.Integer()` in
`TransportMessageSchema` implies.

### B. Stream lifecycle (`streams.property.test.ts`)

The reader/writer semantics in PROTOCOL.md — ordering, half-close, and clean
teardown — for every procedure type.

| #   | Property                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `upload`: the server handler observes exactly the values the client wrote, in write order, and the client gets exactly one result.                                                    |
| B2  | `stream`: for any interleaving of client and server writes, each side receives the other's values in send order, with none dropped or duplicated.                                     |
| B3  | `subscription`: the client's `resReadable` yields exactly the values the server wrote, in order, then completes.                                                                      |
| B4  | Half-close: after the client closes `reqWritable`, the server's `reqReadable` completes but the server can still write, and the client receives those writes until the server closes. |
| B5  | `close(value)` delivers `value` as the final value, then closes.                                                                                                                      |
| B6  | `Writable`: `write()` after `close()` throws, `close()` is idempotent, `isWritable()` is false exactly after close.                                                                   |
| B7  | `Readable`: it can only be consumed once, and `break()` resolves a pending read with `READABLE_BROKEN`.                                                                               |
| B8  | Backpressure is advisory: writing while `write()` returns `false` still delivers every value, in order.                                                                               |

### C. Session and transport under faults (`session.property.test.ts`)

This is the closest analogue to what a deterministic-simulation tool like
Antithesis would explore: generate a fault schedule, then assert the protocol's
delivery guarantees still hold.

| #   | Property                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------- |
| C1  | Exactly-once, in-order delivery holds across any schedule of transparent reconnects.                                  |
| C2  | A receiver only accepts `msg.seq === session.ack`, and sets `ack` to `seq + 1`.                                       |
| C3  | After an ack, the send buffer retains exactly the messages with `seq >= ack` — an unacked message is never dropped.   |
| C4  | No `invariant-violation`-tagged log is ever emitted, under any fault schedule.                                        |
| C5  | A hard reconnect (server loses state) resolves every in-flight call with `UNEXPECTED_DISCONNECT` rather than hanging. |
| C6  | A transparent reconnect preserves the session id.                                                                     |
| C7  | After any fault schedule, cleanup leaves no open sessions or connections.                                             |
| C8  | Concurrent streams sharing one session never mix up their values, across any fault schedule.                          |
| C9a | A connection whose peer is still sending survives arbitrarily long — elapsed time alone is never a missed heartbeat.  |
| C9b | A silent peer is detected and the connection closed within `heartbeatsUntilDead * heartbeatIntervalMs`.               |
| C10 | The server's stored handshake metadata converges on the client's current credential after refreshes and reconnects.   |

C2 and C3 are not asserted by reaching into session internals. The transport
already checks them itself and logs an `invariant-violation`-tagged error when
they break — `assertSendOrdering` on the way out, and the `msg.seq !== session.ack`
branch on the way in. Every property in that file (and in
`streams.property.test.ts`) collects those logs and asserts none were emitted,
which makes C4 the oracle for all three. Testing them through the behavior the
transport already guards is more durable than asserting on private fields.
</content>
</invoke>
