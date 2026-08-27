/*****************************************************************************
Runtime-conformance specs (PObserve): the P model's invariants checked against
REAL executions of the TypeScript implementation.

The hegel property-based suite (or any test run) emits a JSONL trace via
testUtil/fixtures/trace.ts — accepted/encoded frames with seq/ack/flags,
session lifecycle events, and invariant-violation log lines — with zero
library changes (transport events + bindLogger + a wrapper codec). The Java
parser (verification/p/pobserve-bridge) turns each line into one of the
events below; PObserve sorts them by the tap's monotonic counter and routes
them to per-partition monitor instances.

Each spec is checked in its own PObserve run because they partition the
stream differently (see observe.sh):

  AcceptedSeqContiguous      key = sessionId | receiverSide
  EncodedSeqDense            key = side
  SessionStateConformance    key = side | sessionId
  StreamFlagDiscipline       key = sessionId | streamId | receiverSide
  NoInvariantViolations      key = constant

Because a partition IS a session (or stream), "fresh monitor instance" and
"fresh session" coincide: seq contiguity is enforced within a session across
transparent reconnects, and resets naturally with a new session id — the
same scoping as the model checker's ExactlyOnceInOrder monitor.
*****************************************************************************/

// An accepted or encoded transport frame, as observed at one endpoint.
// atServer: which endpoint observed it. For eTAccepted the observer is the
// RECEIVER; for eTEncoded the observer is the SENDER.
type tFrame = (atServer: bool, seqn: int, ack: int, streamId: string,
               sessionId: string, isAck: bool, isOpen: bool, isClose: bool,
               isCancel: bool);

// Session lifecycle, from the transport's sessionStatus/sessionTransition
// events. state is the SessionState string ('NoConnection', 'Connecting',
// 'Handshaking', 'Connected', 'BackingOff').
type tSessionEvt = (atServer: bool, sessionId: string, sname: string);

event eTAccepted: tFrame;        // 'received msg': passed the seq==ack gate
event eTEncoded: tFrame;         // codec tap: outbound frame at encode time
event eTOutOfOrder: tFrame;      // 'received out-of-order msg' (seq > ack)
event eTSessionCreated: tSessionEvt;
event eTSessionTransition: tSessionEvt;
event eTSessionClosing: tSessionEvt;
event eTInvariantViolation: (atServer: bool, message: string);

/*****************************************************************************
C1/C2 on real traces: within one session (partition = sessionId|receiver),
accepted seqs are exactly 0, 1, 2, ... — no gap, duplicate, or reorder ever
reaches the bookkeeping layer, including across transparent reconnects
(same session id => same partition => the counter carries over).
*****************************************************************************/
spec AcceptedSeqContiguous observes eTAccepted {
  var expected: int;
  start state Watching {
    on eTAccepted do (f: tFrame) {
      assert f.seqn == expected,
        format("accepted seq {0} but expected {1} (session {2})", f.seqn, expected, f.sessionId);
      expected = f.seqn + 1;
    }
  }
}

/*****************************************************************************
assertSendOrdering's observable shadow: each endpoint assigns seq numbers
densely at encode time. Encode records carry no session id (the codec sits
below the session), so a reset to 0 is always allowed (a fresh session);
within a session the assignment must be +1. Partition = side.
*****************************************************************************/
spec EncodedSeqDense observes eTEncoded {
  var expected: int;
  start state Watching {
    on eTEncoded do (f: tFrame) {
      assert f.seqn == expected || f.seqn == 0,
        format("encoded seq {0} but expected {1} or 0 (new session)", f.seqn, expected);
      expected = f.seqn + 1;
    }
  }
}

/*****************************************************************************
The session state machine of the implementation must follow the transition
graph the model (and transitions.ts) declares. Partition = side|sessionId.

Client edges: NoConnection->{BackingOff}, BackingOff->{Connecting},
Connecting->{Handshaking, NoConnection}, Handshaking->{Connected,
NoConnection}, Connected->{NoConnection}. (BackingOff->NoConnection is
declared in transitions.ts but marked unused — if a real trace ever takes
it, that is a genuine model/code mismatch worth investigating.)

Server edges: sessions are born Connected (WaitingForHandshakeToConnected),
then Connected<->NoConnection (drop / transparent reconnect adoption).
*****************************************************************************/
spec SessionStateConformance observes eTSessionCreated, eTSessionTransition {
  var cur: string;
  var isServer: bool;
  var started: bool;
  start state Watching {
    on eTSessionCreated do (s: tSessionEvt) {
      assert !started, format("session {0} created twice", s.sessionId);
      started = true;
      isServer = s.atServer;
      if (s.atServer) {
        assert s.sname == "Connected",
          format("server session {0} created in state {1}, expected Connected", s.sessionId, s.sname);
      } else {
        assert s.sname == "NoConnection",
          format("client session {0} created in state {1}, expected NoConnection", s.sessionId, s.sname);
      }
      cur = s.sname;
    }
    on eTSessionTransition do (s: tSessionEvt) {
      // the creation dispatch also emits a transition event for the initial
      // state; accept it as a self-edge on the start state
      if (started && s.sname == cur) {
        return;
      }
      assert started, format("transition for unknown session {0}", s.sessionId);
      if (isServer) {
        assert legalServerEdge(cur, s.sname),
          format("server session {0}: illegal transition {1} -> {2}", s.sessionId, cur, s.sname);
      } else {
        assert legalClientEdge(cur, s.sname),
          format("client session {0}: illegal transition {1} -> {2}", s.sessionId, cur, s.sname);
      }
      cur = s.sname;
    }
  }

  fun legalClientEdge(a: string, b: string): bool {
    if (a == "NoConnection") {
      return b == "BackingOff";
    }
    if (a == "BackingOff") {
      return b == "Connecting";
    }
    if (a == "Connecting") {
      return b == "Handshaking" || b == "NoConnection";
    }
    if (a == "Handshaking") {
      return b == "Connected" || b == "NoConnection";
    }
    if (a == "Connected") {
      return b == "NoConnection";
    }
    return false;
  }

  fun legalServerEdge(a: string, b: string): bool {
    if (a == "Connected") {
      return b == "NoConnection";
    }
    if (a == "NoConnection") {
      return b == "Connected";
    }
    return false;
  }
}

/*****************************************************************************
B-series flag discipline on real traces, per stream pipe
(partition = sessionId|streamId|receiverSide; reserved control streams are
filtered out by the parser):
  - the request pipe's first accepted frame carries StreamOpenBit, and only
    the first;
  - after a sender's Close or Cancel, that sender writes nothing further on
    the stream (half-close: the OTHER side may keep writing).
*****************************************************************************/
spec StreamFlagDiscipline observes eTAccepted {
  var seen: bool;
  var senderClosed: bool;
  start state Watching {
    on eTAccepted do (f: tFrame) {
      if (f.atServer) {
        // request pipe: client-opened
        if (!seen) {
          assert f.isOpen,
            format("first frame of stream {0} lacks StreamOpenBit", f.streamId);
        } else {
          assert !f.isOpen,
            format("stream {0} opened twice", f.streamId);
        }
      }
      assert !senderClosed,
        format("frame on stream {0} after the sender closed its writer", f.streamId);
      seen = true;
      if (f.isClose || f.isCancel) {
        senderClosed = true;
      }
    }
  }
}

/*****************************************************************************
C4 on real traces: the implementation's own invariant-violation log lines
(assertSendOrdering, seq > ack among honest peers, session-map invariants)
must never fire, and neither should the out-of-order receive path — the
transport under test runs over reliable in-order connections.
*****************************************************************************/
spec NoInvariantViolations observes eTInvariantViolation, eTOutOfOrder {
  start state Watching {
    on eTInvariantViolation do (v: (atServer: bool, message: string)) {
      assert false, format("implementation logged an invariant violation: {0}", v.message);
    }
    on eTOutOfOrder do (f: tFrame) {
      assert false,
        format("out-of-order frame reached an endpoint (seq {0}) over a reliable connection", f.seqn);
    }
  }
}
