/*****************************************************************************
River protocol model: shared types, events, and helper functions.

The model covers the transport/session layer of PROTOCOL.md: seq/ack
exactly-once bookkeeping, the send buffer, the 4-case handshake, transparent
vs hard reconnects, and the session grace period. Payloads are monotonically
increasing ints issued by the test driver; the server echoes every accepted
app message back, which stands in for an rpc response (bidirectional traffic
exercises both directions' seq/ack windows and gives calls a natural
resolution point).
*****************************************************************************/

enum tMsgKind {
  MSG_APP,
  MSG_ACK,      // heartbeat (AckBit); rides the normal seq/ack path
  MSG_RH_REQ,   // ControlRehandshakeRequest  (server -> client), reserved streamId
  MSG_RH_RESP   // ControlRehandshakeResponse (client -> server); payload = credential
}

enum tDropMode {
  DROP_BOTH,         // close event delivered to both sides
  DROP_CLIENT_ONLY,  // only the client learns the connection died
  DROP_SERVER_ONLY,  // only the server learns (needs watchdog; phase 2)
  DROP_SILENT        // neither side learns (phantom disconnect; phase 2)
}

// A transport message. In the TS implementation the encoded bytes are cached
// in the send buffer, so retransmits are byte-identical: a replayed message
// carries its ORIGINAL (possibly stale) ack. tMsg mirrors that: it is stamped
// once at enqueue time and never re-stamped.
//
// Stream overlay (B-series): app messages belong to a stream. `sid` is the
// wire stream id (unique per stream instance, client-generated), `sopen` is
// the StreamOpenBit (first message of a stream, client-only), `sclose` is the
// StreamClosedBit (the sender closes its writer; the other side may keep
// writing — half-close). Control messages use sid 0 and no flags.
type tMsg = (seqn: int, ack: int, kind: tMsgKind, payload: int,
             sid: int, sopen: bool, sclose: bool);

// Messages delivered by a connection are tagged with the connection's id so
// endpoints can drop deliveries from a connection they no longer own
// (the TS impl detaches the old connection's listeners instead).
type tWireMsg = (connId: int, msg: tMsg);

// Handshake frames are out-of-band (seq 0 / ack 0 in TS) and do not consume
// seq numbers. `conn` lets the server respond on the requesting connection.
type tHsReq = (connId: int, conn: machine, sessionId: int,
               nextExpectedSeq: int,  // = client session.ack
               nextSentSeq: int,      // = client session.nextSeq()
               isReconnect: bool,     // client session was previously Connected
               meta: int);            // handshake metadata (credential)
type tHsResp = (connId: int, ok: bool, sessionId: int, retriable: bool);

type tConnCfg = (client: machine, server: machine, connId: int);
// streamWidth: app payloads per stream — payloads are assigned round-robin in
// blocks (width 2: payloads 1,2 -> stream 1; 3,4 -> stream 2; ...). The last
// payload of a block carries the client's half-close.
type tClientCfg = (orch: machine, server: machine, maxRetries: int, corruptBudget: int,
                   streamWidth: int);
// consumedGuardFixed models commit d7c0ec9: when true, the rehandshake
// teardown checks `session._isConsumed` first and returns silently on a stale
// handle; when false (the pre-fix code), touching a consumed session state
// crashes (an unhandled rejection in TS, an assertion here).
// zeroStateGuardFixed: when true, the server honors the handshake's
// isReconnect flag and rejects a reconnect to a session it lost even when
// the client's seq counters are all-zero; when false (the pre-fix protocol),
// such a reconnect is accepted as a NEW session and the client's replay
// re-delivers already-delivered payloads (the model checker found this;
// reproduced against the TS implementation in __tests__/zerostate.test.ts).
type tServerCfg = (orch: machine, expectHonest: bool, consumedGuardFixed: bool,
                   zeroStateGuardFixed: bool);
// dropMix selects which tDropMode values the fault injector may choose:
//   0 = DROP_BOTH only
//   1 = DROP_BOTH | DROP_CLIENT_ONLY
//   2 = any, including DROP_SERVER_ONLY and DROP_SILENT (phantom disconnect;
//       requires the watchdog to unstick the unnotified side)
type tOrchCfg = (n: int, dropBudget: int, dropMix: int, restartBudget: int,
                 heartbeatBudget: int, rehandshakeBudget: int, corruptBudget: int,
                 expectHonest: bool, consumedGuardFixed: bool,
                 zeroStateGuardFixed: bool);

/******************************* app-facing *********************************/
event eAppSend: int;                             // driver -> client: issue call
event eCallResolved: (payload: int, ok: bool);   // client -> driver
event eShutdown;                                 // driver -> both endpoints
event eRestart;                                  // driver -> server: lose all state
event eConnCreated: machine;                     // client -> driver (fault hook)

/*************************** connection lifecycle ****************************/
event eConnEstablished: (connId: int, conn: machine); // conn -> client
event eConnClosed: int;                               // conn -> endpoint (connId)
event eConnCloseCmd;                                  // endpoint -> conn
event eFaultDrop: tDropMode;                          // driver -> conn
// Watchdog detection (C9b, untimed): a side that was NOT notified of a dead
// connection eventually notices (TS: lastInboundAt falls behind
// heartbeatsUntilDead * heartbeatIntervalMs and the watchdog closes the
// connection). Modeled as a deferred eConnClosed delivered by the dead
// connection to the unnotified side(s). The timing bound itself (C9a: a live
// peer is never falsely killed) is a wall-clock property outside an untimed
// model's reach.
event eWatchdogDetect: int;                           // conn -> itself (defers)
event eHeartbeatNudge;                                // driver -> server: fire one heartbeat
event eRehandshakeNudge;                              // driver -> server: refresh credentials

/****************************** rehandshake *********************************/
// The TS implementation has two async gaps in the rehandshake exchange, both
// implicated in the d7c0ec9 bug class:
//   - the client's construct() (rebuilding handshake metadata) — a hard
//     reconnect during it must make the bound send throw, not deliver stale
//     metadata to the replacement session
//   - the server's validate() — it can complete after the session state it
//     captured was consumed by a transition
// Both are modeled as deferred self-events carrying the identity captured at
// the start of the gap: sessGen (which session) and connEpoch (which
// Connected-state instance — TS's linear-typed, consumable state object).
event eConstructDone: (sessGen: int, defers: int);                  // client -> itself
event eValidateDone: (sessGen: int, connEpoch: int, reject: bool,
                      meta: int, defers: int);                      // server -> itself

/******************************** wire traffic ******************************/
event eSendMsg: (toServer: bool, msg: tMsg);  // endpoint -> conn
event eDeliverMsg: tWireMsg;                  // conn -> endpoint
event eSendHsReq: tHsReq;                     // client -> conn
event eDeliverHsReq: tHsReq;                  // conn -> server
event eSendHsResp: tHsResp;                   // server -> conn
event eDeliverHsResp: tHsResp;                // conn -> client

/********************************** timers **********************************/
// Timers are modeled as generation-guarded fire events routed through a
// separate EchoTimer machine: the fire lands in the owner's queue at a
// scheduler-chosen point, so the checker explores every firing interleaving.
// A generation mismatch means the timer was cancelled (owner bumped its gen).
//
// A naive immediate echo would land the fire EARLY in the owner's FIFO queue
// in most schedules (before the handshake even completes), biasing the search
// toward grace-killed sessions. The timer therefore defers the fire a
// nondeterministic, budgeted number of times via self-sends — each defer
// pushes the fire to the back of the owner's arrival order, so late firings
// (the realistic case: grace is seconds, a reconnect is milliseconds) are
// explored too.
event eStartGrace: int;                        // owner -> timer (generation)
event eGraceFired: int;                        // timer -> owner (generation)
event eTimerDefer: (gen: int, defers: int);    // timer -> itself

/***************************** spec announcements ****************************/
event eSpecCall: int;                                  // driver issued a call
event eSpecResolved: (payload: int, ok: bool);         // call resolved (once)
event eSpecDeliver: (atServer: bool, payload: int);    // app payload accepted
event eSpecReset;                                      // a session was destroyed (hard reset)
event eSpecTransparentReconnect: (oldId: int, newId: int);
event eSpecShutdownStarted;
event eSpecClosed: bool;                               // endpoint closed (atServer)

/********************************* helpers **********************************/

// C3 (strengthened): the send buffer holds exactly the window
// [maxAckSeen, seqNum) of contiguous seqs — an unacked message is never
// dropped and an acked one never lingers. Mirrors the TS invariant that the
// hegel tests check via the `invariant-violation` log oracle.
fun assertBufferWindow(buffer: seq[tMsg], seqNum: int, maxAckSeen: int) {
  var i: int;
  if (sizeof(buffer) == 0) {
    assert maxAckSeen == seqNum,
      format("send buffer empty but window [{0}, {1}) not empty: unacked messages were dropped", maxAckSeen, seqNum);
  } else {
    assert buffer[0].seqn == maxAckSeen,
      format("send buffer starts at {0}, expected peer-acked lower bound {1}", buffer[0].seqn, maxAckSeen);
    i = 0;
    while (i < sizeof(buffer)) {
      assert buffer[i].seqn == buffer[0].seqn + i,
        format("send buffer not contiguous at index {0}", i);
      i = i + 1;
    }
    assert buffer[sizeof(buffer) - 1].seqn + 1 == seqNum,
      format("send buffer ends at {0}, expected seqNum {1}", buffer[sizeof(buffer) - 1].seqn + 1, seqNum);
  }
}

machine EchoTimer {
  var target: machine;
  start state Idle {
    entry (t: machine) { target = t; }
    on eStartGrace do (gen: int) {
      send this, eTimerDefer, (gen = gen, defers = 3);
    }
    on eTimerDefer do (t: (gen: int, defers: int)) {
      if (t.defers > 0 && $) {
        send this, eTimerDefer, (gen = t.gen, defers = t.defers - 1);
      } else {
        send target, eGraceFired, t.gen;
      }
    }
  }
}
