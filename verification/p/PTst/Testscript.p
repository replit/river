/*****************************************************************************
Test scenarios.

The Orchestrator is the test driver: it spawns the server and client, issues
N calls, injects a budgeted number of nondeterministic faults, and shuts
everything down once every call has resolved. A fault decision is made when a
connection is created; the eFaultDrop event's DELIVERY point is chosen by the
scheduler, so the drop lands at an arbitrary position in that connection's
message stream (the same shape as the hegel write-schedule generator).

The session grace period races with reconnects in every scenario for free:
grace firing is a scheduler choice, not a scripted step.

  tcHappyPath   — no faults: pure seq/ack + handshake sanity
  tcDrops       — up to 3 connection drops (both-sided or client-only):
                  the core transparent-reconnect test (C1/C2/C3/C6)
  tcRestart     — a server restart plus up to 1 drop: hard reconnect,
                  UNEXPECTED_DISCONNECT resolution (C5)
  tcByzantine   — a misbehaving client injects duplicate/future seqs: the
                  server must drop duplicates silently and close the
                  connection (not the session) on future seqs
  tcPhantom     — one-sided and silent drops (phantom disconnects): the
                  unnotified side is unstuck only by the heartbeat watchdog's
                  eventual detection (C9b, untimed); heartbeats ride the
                  normal seq/ack path
  tcRehandshake — server-initiated credential refreshes racing connection
                  drops; the d7c0ec9 consumed-handle guard is ON (expect no
                  bug)
  tcD7c0ec9Regression
                — same scenario with the PRE-FIX teardown (no consumed-handle
                  guard): the checker must FIND the crash — a model-level
                  regression test for the d7c0ec9 bug class
*****************************************************************************/

machine Orchestrator {
  var n: int;
  var dropsLeft: int;
  var dropMix: int;
  var restartsLeft: int;
  var heartbeatsLeft: int;
  var rehandshakesLeft: int;
  var resolvedCount: int;
  var client: machine;
  var server: machine;

  start state Boot {
    entry (cfg: tOrchCfg) {
      var i: int;
      n = cfg.n;
      dropsLeft = cfg.dropBudget;
      dropMix = cfg.dropMix;
      restartsLeft = cfg.restartBudget;
      heartbeatsLeft = cfg.heartbeatBudget;
      rehandshakesLeft = cfg.rehandshakeBudget;
      server = new ServerTransport((orch = this, expectHonest = cfg.expectHonest,
                                    consumedGuardFixed = cfg.consumedGuardFixed,
                                    zeroStateGuardFixed = cfg.zeroStateGuardFixed));
      client = new ClientTransport((orch = this, server = server,
                                    maxRetries = 3, corruptBudget = cfg.corruptBudget,
                                    streamWidth = 2));
      i = 1;
      while (i <= n) {
        announce eSpecCall, i;
        send client, eAppSend, i;
        i = i + 1;
      }
      goto Run;
    }
  }

  state Run {
    on eConnCreated do (c: machine) {
      maybeRestart();
      maybeHeartbeat();
      maybeRehandshake();
      if (dropsLeft > 0 && $) {
        dropsLeft = dropsLeft - 1;
        send c, eFaultDrop, pickDropMode();
      }
    }
    on eCallResolved do (r: (payload: int, ok: bool)) {
      resolvedCount = resolvedCount + 1;
      maybeRestart();
      maybeHeartbeat();
      maybeRehandshake();
      if (resolvedCount == n) {
        announce eSpecShutdownStarted;
        send client, eShutdown;
        send server, eShutdown;
      }
    }
  }

  fun pickDropMode(): tDropMode {
    var pick: int;
    if (dropMix == 0) {
      return DROP_BOTH;
    }
    if (dropMix == 1) {
      if ($) {
        return DROP_CLIENT_ONLY;
      }
      return DROP_BOTH;
    }
    pick = choose(4);
    if (pick == 0) {
      return DROP_BOTH;
    }
    if (pick == 1) {
      return DROP_CLIENT_ONLY;
    }
    if (pick == 2) {
      return DROP_SERVER_ONLY;
    }
    return DROP_SILENT;
  }

  fun maybeRestart() {
    if (restartsLeft > 0 && $) {
      restartsLeft = restartsLeft - 1;
      send server, eRestart;
    }
  }

  fun maybeHeartbeat() {
    if (heartbeatsLeft > 0 && $) {
      heartbeatsLeft = heartbeatsLeft - 1;
      send server, eHeartbeatNudge;
    }
  }

  fun maybeRehandshake() {
    if (rehandshakesLeft > 0 && $) {
      rehandshakesLeft = rehandshakesLeft - 1;
      send server, eRehandshakeNudge;
    }
  }
}

machine MainHappyPath {
  start state Init {
    entry {
      new Orchestrator((n = 4, dropBudget = 0, dropMix = 0, restartBudget = 0,
                        heartbeatBudget = 1, rehandshakeBudget = 0, corruptBudget = 0,
                        expectHonest = true, consumedGuardFixed = true,
                        zeroStateGuardFixed = true));
    }
  }
}

machine MainDrops {
  start state Init {
    entry {
      new Orchestrator((n = 4, dropBudget = 3, dropMix = 1, restartBudget = 0,
                        heartbeatBudget = 1, rehandshakeBudget = 0, corruptBudget = 0,
                        expectHonest = true, consumedGuardFixed = true,
                        zeroStateGuardFixed = true));
    }
  }
}

machine MainRestart {
  start state Init {
    entry {
      new Orchestrator((n = 3, dropBudget = 1, dropMix = 1, restartBudget = 1,
                        heartbeatBudget = 1, rehandshakeBudget = 0, corruptBudget = 0,
                        expectHonest = true, consumedGuardFixed = true,
                        zeroStateGuardFixed = true));
    }
  }
}

machine MainByzantine {
  start state Init {
    entry {
      new Orchestrator((n = 3, dropBudget = 1, dropMix = 0, restartBudget = 0,
                        heartbeatBudget = 0, rehandshakeBudget = 0, corruptBudget = 2,
                        expectHonest = false, consumedGuardFixed = true,
                        zeroStateGuardFixed = true));
    }
  }
}

machine MainPhantom {
  start state Init {
    entry {
      new Orchestrator((n = 3, dropBudget = 2, dropMix = 2, restartBudget = 0,
                        heartbeatBudget = 2, rehandshakeBudget = 0, corruptBudget = 0,
                        expectHonest = true, consumedGuardFixed = true,
                        zeroStateGuardFixed = true));
    }
  }
}

machine MainRehandshake {
  start state Init {
    entry {
      new Orchestrator((n = 3, dropBudget = 2, dropMix = 1, restartBudget = 0,
                        heartbeatBudget = 0, rehandshakeBudget = 2, corruptBudget = 0,
                        expectHonest = true, consumedGuardFixed = true,
                        zeroStateGuardFixed = true));
    }
  }
}

// The d7c0ec9 regression, pre-fix: the rehandshake teardown does NOT guard
// against consumed session states. The checker MUST find the assertion (a
// crash / unhandled rejection in TS) — check.sh runs this test expecting a
// bug to be found.
machine MainD7c0ec9Regression {
  start state Init {
    entry {
      new Orchestrator((n = 3, dropBudget = 2, dropMix = 1, restartBudget = 0,
                        heartbeatBudget = 0, rehandshakeBudget = 2, corruptBudget = 0,
                        expectHonest = true, consumedGuardFixed = false,
                        zeroStateGuardFixed = true));
    }
  }
}

// The zero-state duplicate-delivery regression, pre-fix: the server does not
// honor the handshake's isReconnect flag, so a zero-state reconnect to a
// server that lost the session (restart) is accepted as new and the client's
// replay re-delivers. The checker MUST find the strengthened
// ExactlyOnceInOrder violation — check.sh runs this expecting a bug.
machine MainZeroStateDup {
  start state Init {
    entry {
      new Orchestrator((n = 3, dropBudget = 1, dropMix = 0, restartBudget = 1,
                        heartbeatBudget = 0, rehandshakeBudget = 0, corruptBudget = 0,
                        expectHonest = true, consumedGuardFixed = true,
                        zeroStateGuardFixed = false));
    }
  }
}

module River = { ClientTransport, ServerTransport, WsConnection, EchoTimer, Orchestrator };

test tcHappyPath [main=MainHappyPath]:
  assert ExactlyOnceInOrder, AllCallsResolve, SessionIdPreserved, CleanShutdown in
  (union River, { MainHappyPath });

test tcDrops [main=MainDrops]:
  assert ExactlyOnceInOrder, AllCallsResolve, SessionIdPreserved, CleanShutdown in
  (union River, { MainDrops });

test tcRestart [main=MainRestart]:
  assert ExactlyOnceInOrder, AllCallsResolve, SessionIdPreserved, CleanShutdown in
  (union River, { MainRestart });

test tcByzantine [main=MainByzantine]:
  assert ExactlyOnceInOrder, AllCallsResolve, SessionIdPreserved, CleanShutdown in
  (union River, { MainByzantine });

test tcPhantom [main=MainPhantom]:
  assert ExactlyOnceInOrder, AllCallsResolve, SessionIdPreserved, CleanShutdown in
  (union River, { MainPhantom });

test tcRehandshake [main=MainRehandshake]:
  assert ExactlyOnceInOrder, AllCallsResolve, SessionIdPreserved, CleanShutdown in
  (union River, { MainRehandshake });

test tcD7c0ec9Regression [main=MainD7c0ec9Regression]:
  assert ExactlyOnceInOrder, AllCallsResolve, SessionIdPreserved, CleanShutdown in
  (union River, { MainD7c0ec9Regression });

test tcZeroStateDup [main=MainZeroStateDup]:
  assert ExactlyOnceInOrder, AllCallsResolve, SessionIdPreserved, CleanShutdown in
  (union River, { MainZeroStateDup });
