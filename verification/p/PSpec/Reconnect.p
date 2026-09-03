/*****************************************************************************
Reconnect / lifecycle specs.

SessionIdPreserved (C6): a transparent reconnect adopts the SAME session id.

CleanShutdown (C7): once shutdown starts, both endpoints eventually announce
that they closed (sessions destroyed, connections closed). Hot until then.
*****************************************************************************/

spec SessionIdPreserved observes eSpecTransparentReconnect {
  start state Watching {
    on eSpecTransparentReconnect do (t: (oldId: int, newId: int)) {
      assert t.oldId == t.newId,
        format("transparent reconnect changed session id {0} -> {1}", t.oldId, t.newId);
    }
  }
}

spec CleanShutdown observes eSpecShutdownStarted, eSpecClosed {
  var serverClosed: bool;
  var clientClosed: bool;

  start cold state BeforeShutdown {
    on eSpecClosed do (atServer: bool) { note(atServer); }
    on eSpecShutdownStarted do {
      if (serverClosed && clientClosed) {
        goto AllClosed;
      } else {
        goto Waiting;
      }
    }
  }

  hot state Waiting {
    on eSpecClosed do (atServer: bool) {
      note(atServer);
      if (serverClosed && clientClosed) {
        goto AllClosed;
      }
    }
    ignore eSpecShutdownStarted;
  }

  cold state AllClosed {
    ignore eSpecClosed, eSpecShutdownStarted;
  }

  fun note(atServer: bool) {
    if (atServer) {
      serverClosed = true;
    } else {
      clientClosed = true;
    }
  }
}
