/*****************************************************************************
Delivery specs.

ExactlyOnceInOrder (C1, C2 observable consequence): between session resets,
app payloads are accepted by each side exactly once, in issue order, with no
gaps or duplicates — in particular across any schedule of TRANSPARENT
reconnects, which announce nothing to this monitor.

After an eSpecReset (a session was destroyed: grace expiry, server restart,
hard reconnect, retriable rejection) a delivery GAP is allowed — messages
die with their session and resolve UNEXPECTED_DISCONNECT — but re-delivery
of an already-delivered payload is NOT: the watermark may only move forward.

Historical note: re-delivery across a reset used to be possible (the model
checker surfaced it, and __tests__/zerostate.test.ts reproduced it against
the TypeScript implementation): if the server delivered a message but every
ack/echo back to the client was lost, and the server then lost the session
before the client reconnected, the client's handshake presented
nextSentSeq=0/nextExpectedSeq=0 — indistinguishable from a brand-new
session — so the server accepted it (connect case 4) and the client's
buffer replay re-executed handlers. The handshake's
expectedSessionState.isReconnect flag closes that window; the model keeps
the pre-fix behavior behind zeroStateGuardFixed=false, and tcZeroStateDup
asserts the checker still FINDS the duplicate there.

AllCallsResolve (C5 + liveness): every issued call resolves exactly once —
with a value, or with UNEXPECTED_DISCONNECT when its session died. The
monitor is hot while any call is unresolved, so an execution that quiesces
with a hanging call is a liveness bug.
*****************************************************************************/

spec ExactlyOnceInOrder observes eSpecDeliver, eSpecReset {
  var expectedAtServer: int;
  var expectedAtClient: int;
  var freshAtServer: bool;  // a reset happened since the last delivery
  var freshAtClient: bool;

  start state Watching {
    entry {
      expectedAtServer = 1;
      expectedAtClient = 1;
    }
    on eSpecDeliver do (d: (atServer: bool, payload: int)) {
      if (d.atServer) {
        if (freshAtServer) {
          assert d.payload >= expectedAtServer,
            format("server re-delivered {0} after a session reset (watermark {1})",
                   d.payload, expectedAtServer);
        } else {
          assert d.payload == expectedAtServer,
            format("server delivered {0}, expected {1}, with no intervening session reset",
                   d.payload, expectedAtServer);
        }
        expectedAtServer = d.payload + 1;
        freshAtServer = false;
      } else {
        if (freshAtClient) {
          assert d.payload >= expectedAtClient,
            format("client re-delivered {0} after a session reset (watermark {1})",
                   d.payload, expectedAtClient);
        } else {
          assert d.payload == expectedAtClient,
            format("client delivered {0}, expected {1}, with no intervening session reset",
                   d.payload, expectedAtClient);
        }
        expectedAtClient = d.payload + 1;
        freshAtClient = false;
      }
    }
    on eSpecReset do {
      freshAtServer = true;
      freshAtClient = true;
    }
  }
}

spec AllCallsResolve observes eSpecCall, eSpecResolved {
  var pending: map[int, bool];
  var everResolved: map[int, bool];

  start cold state AllResolved {
    on eSpecCall do (p: int) {
      trackCall(p);
      goto Pending;
    }
    on eSpecResolved do (r: (payload: int, ok: bool)) {
      assert false, format("call {0} resolved twice (nothing pending)", r.payload);
    }
  }

  hot state Pending {
    on eSpecCall do (p: int) { trackCall(p); }
    on eSpecResolved do (r: (payload: int, ok: bool)) {
      assert r.payload in pending,
        format("call {0} resolved but was not pending (double resolution?)", r.payload);
      pending -= (r.payload);
      everResolved[r.payload] = true;
      if (sizeof(pending) == 0) {
        goto AllResolved;
      }
    }
  }

  fun trackCall(p: int) {
    assert !(p in pending) && !(p in everResolved),
      format("call {0} issued twice", p);
    pending[p] = true;
  }
}
