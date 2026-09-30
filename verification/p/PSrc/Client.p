/*****************************************************************************
ClientTransport: the client-side session state machine.

State mapping to transport/sessionStateMachine/transitions.ts:
  Idle        — no session exists (TS: session deleted; a new call re-creates)
  Connecting  — SessionNoConnection + SessionBackingOff + SessionConnecting
                collapsed: backoff duration is abstracted away (only orderings
                matter, and each P state entry is its own scheduling point)
  Handshaking — SessionHandshaking
  Connected   — SessionConnected
  Dead        — retry budget exhausted (conn_retry_exceeded) or fatal
                handshake rejection: transport stays down, every call
                resolves UNEXPECTED_DISCONNECT
  Done        — after eShutdown

Session state carried across reconnects (TS inheritSharedSession): sessionId,
seqNum, seqSent, ackNum, sendBuffer (+ maxAckSeen, the model's explicit
"highest peer ack seen", implicit in TS).

Grace period: armed (gen++) at session creation and on Connected->disconnected,
NOT re-armed across Connecting/Handshaking cycles (TS: absolute deadline),
cancelled (gen++ without re-arm) on entering Connected.
*****************************************************************************/

machine ClientTransport {
  var orch: machine;
  var server: machine;
  var timer: machine;
  var maxRetries: int;
  var retriesLeft: int;
  var corruptBudget: int;

  var hasSession: bool;
  var sessionId: int;
  var sessCounter: int;
  var seqNum: int;      // next seq to assign
  var seqSent: int;     // last seq written to a live connection (-1 = none)
  var ackNum: int;      // next expected inbound seq
  var maxAckSeen: int;  // highest peer ack processed
  var sendBuffer: seq[tMsg];
  var pendingCalls: map[int, bool];  // issued, unresolved payloads

  var conn: machine;
  var connId: int;      // -1 = no current connection
  var connCounter: int;
  var graceGen: int;
  var hadConnection: bool;  // this session previously reached Connected
  var credential: int;  // current handshake metadata; construct() may refresh it
  var streamWidth: int;
  // per logical stream key: wire sid, requests nsent, half-closed by us,
  // response pipe closed by the server
  var streams: map[int, (sid: int, nsent: int, closedLocal: bool, serverClosed: bool)];

  start state Boot {
    entry (cfg: tClientCfg) {
      orch = cfg.orch;
      server = cfg.server;
      maxRetries = cfg.maxRetries;
      retriesLeft = cfg.maxRetries;
      corruptBudget = cfg.corruptBudget;
      streamWidth = cfg.streamWidth;
      timer = new EchoTimer(this);
      connId = -1;
      credential = 1;
      goto Idle;
    }
  }

  // No session. Everything that arrives here is stale except a new call.
  state Idle {
    on eAppSend do (p: int) {
      newSession();
      enqueueApp(p);
      goto Connecting;
    }
    on eShutdown do {
      announce eSpecClosed, false;
      goto Done;
    }
    on eConstructDone do (t: (sessGen: int, defers: int)) { handleConstructDone(t, false); }
    ignore eConnClosed, eDeliverMsg, eDeliverHsResp, eConnEstablished, eGraceFired;
  }

  state Connecting {
    entry {
      if (retriesLeft <= 0) {
        destroySession();
        goto Dead;
      } else {
        retriesLeft = retriesLeft - 1;
        connCounter = connCounter + 1;
        connId = connCounter;
        conn = new WsConnection((client = this, server = server, connId = connId));
        send orch, eConnCreated, conn;
      }
    }
    on eConnEstablished do (e: (connId: int, conn: machine)) {
      if (e.connId == connId) {
        goto Handshaking;
      }
    }
    on eConnClosed do (cid: int) {
      if (cid == connId) {
        connId = -1;
        goto Connecting;
      }
    }
    on eGraceFired do (g: int) {
      if (g == graceGen) {
        destroySession();
        goto Idle;
      }
    }
    on eAppSend do (p: int) { enqueueApp(p); }
    on eDeliverMsg do (w: tWireMsg) { assert w.connId != connId, "msg on conn before established"; }
    on eDeliverHsResp do (h: tHsResp) { assert h.connId != connId, "hs resp before hs req"; }
    on eConstructDone do (t: (sessGen: int, defers: int)) { handleConstructDone(t, false); }
    on eShutdown do { shutdownNow(); goto Done; }
  }

  state Handshaking {
    entry {
      send conn, eSendHsReq, (connId = connId, conn = conn, sessionId = sessionId,
                              nextExpectedSeq = ackNum, nextSentSeq = nextSeqLocal(),
                              isReconnect = hadConnection, meta = construct());
    }
    on eDeliverHsResp do (h: tHsResp) {
      if (h.connId != connId) {
        return;  // stale connection
      }
      if (!h.ok) {
        send conn, eConnCloseCmd;
        connId = -1;
        if (h.retriable) {
          // SESSION_STATE_MISMATCH: delete the session and reconnect with a
          // FRESH session (seq/ack = 0). In-flight calls die.
          destroySession();
          newSession();
          goto Connecting;
        } else {
          // fatal rejection: transport stays down
          destroySession();
          goto Dead;
        }
      } else if (h.sessionId != sessionId) {
        // TS: a mismatched session id in an ok response is itself fatal
        send conn, eConnCloseCmd;
        connId = -1;
        destroySession();
        goto Dead;
      } else {
        goto Connected;
      }
    }
    on eConnClosed do (cid: int) {
      if (cid == connId) {
        connId = -1;
        goto Connecting;
      }
    }
    on eGraceFired do (g: int) {
      if (g == graceGen) {
        destroySession();
        goto Idle;
      }
    }
    on eAppSend do (p: int) { enqueueApp(p); }
    on eDeliverMsg do (w: tWireMsg) { assert w.connId != connId, "msg before handshake resp"; }
    on eConstructDone do (t: (sessGen: int, defers: int)) { handleConstructDone(t, false); }
    ignore eConnEstablished;
    on eShutdown do { shutdownNow(); goto Done; }
  }

  state Connected {
    entry {
      hadConnection = true;
      graceGen = graceGen + 1;    // cancel grace (no re-arm)
      retriesLeft = maxRetries;   // TS restores the retry budget on connect
      replayBuffer();
      maybeCorrupt();
    }
    on eDeliverMsg do (w: tWireMsg) {
      if (w.connId != connId) {
        return;  // stale connection
      }
      if (w.msg.seqn < ackNum) {
        return;  // duplicate: silently discarded
      }
      // seq > ack from the (honest) server would be a protocol invariant
      // violation — the TS client logs `invariant-violation` and closes the
      // connection. In this model the server is always honest, so it is
      // simply unreachable.
      assert w.msg.seqn == ackNum,
        format("client received out-of-order seq {0}, expected {1}", w.msg.seqn, ackNum);
      acceptMsg(w.msg);
    }
    on eConnClosed do (cid: int) {
      if (cid == connId) {
        connId = -1;
        graceGen = graceGen + 1;
        send timer, eStartGrace, graceGen;
        goto Connecting;
      }
    }
    on eAppSend do (p: int) {
      transmit(enqueueApp(p));
      maybeCorrupt();
    }
    on eDeliverHsResp do (h: tHsResp) { assert h.connId != connId, "duplicate handshake resp"; }
    on eConstructDone do (t: (sessGen: int, defers: int)) { handleConstructDone(t, true); }
    ignore eConnEstablished, eGraceFired;
    on eShutdown do { shutdownNow(); goto Done; }
  }

  state Dead {
    on eAppSend do (p: int) {
      announce eSpecResolved, (payload = p, ok = false);
      send orch, eCallResolved, (payload = p, ok = false);
    }
    on eShutdown do {
      announce eSpecClosed, false;
      goto Done;
    }
    ignore eConnClosed, eDeliverMsg, eDeliverHsResp, eConnEstablished, eGraceFired,
           eConstructDone;
  }

  state Done {
    ignore eAppSend, eShutdown, eConnClosed, eDeliverMsg, eDeliverHsResp,
           eConnEstablished, eGraceFired, eConstructDone;
  }

  /********************************* session **********************************/

  fun newSession() {
    sessCounter = sessCounter + 1;
    sessionId = sessCounter;
    hasSession = true;
    seqNum = 0;
    seqSent = -1;
    ackNum = 0;
    maxAckSeen = 0;
    sendBuffer = default(seq[tMsg]);
    pendingCalls = default(map[int, bool]);
    hadConnection = false;
    streams = default(map[int, (sid: int, nsent: int, closedLocal: bool, serverClosed: bool)]);
    // TS arms the grace period at session creation (createUnconnectedSession)
    graceGen = graceGen + 1;
    send timer, eStartGrace, graceGen;
  }

  fun destroySession() {
    resolveAllDisconnect();
    hasSession = false;
    announce eSpecReset;
    if (connId != -1) {
      send conn, eConnCloseCmd;
      connId = -1;
    }
  }

  fun shutdownNow() {
    if (hasSession) {
      destroySession();
    }
    announce eSpecClosed, false;
  }

  fun resolveAllDisconnect() {
    var ks: seq[int];
    var i: int;
    ks = keys(pendingCalls);
    i = 0;
    while (i < sizeof(ks)) {
      announce eSpecResolved, (payload = ks[i], ok = false);
      send orch, eCallResolved, (payload = ks[i], ok = false);
      i = i + 1;
    }
    pendingCalls = default(map[int, bool]);
  }

  /********************************** wire ***********************************/

  fun nextSeqLocal(): int {
    if (sizeof(sendBuffer) > 0) {
      return sendBuffer[0].seqn;
    }
    return seqNum;
  }

  // Mirrors IdentifiedSession.send: stamp seq/ack once, buffer, bump seq.
  fun enqueueMsg(kind: tMsgKind, p: int, sid: int, sopen: bool, sclose: bool): tMsg {
    var m: tMsg;
    m = (seqn = seqNum, ack = ackNum, kind = kind, payload = p,
         sid = sid, sopen = sopen, sclose = sclose);
    seqNum = seqNum + 1;
    sendBuffer += (sizeof(sendBuffer), m);
    assertBufferWindow(sendBuffer, seqNum, maxAckSeen);
    return m;
  }

  // Route an app payload onto its stream: OPEN on the first message of a
  // stream instance, half-CLOSE on the last. Stream instances are per
  // session (a session reset kills every stream; later payloads open fresh
  // streams on the replacement session).
  fun enqueueApp(p: int): tMsg {
    var k: int;
    var st: (sid: int, nsent: int, closedLocal: bool, serverClosed: bool);
    var isOpen: bool;
    var isClose: bool;
    pendingCalls[p] = true;
    k = (p + streamWidth - 1) / streamWidth;
    if (!(k in streams)) {
      streams[k] = (sid = sessCounter * 100 + k, nsent = 0,
                    closedLocal = false, serverClosed = false);
      isOpen = true;
    }
    st = streams[k];
    assert !st.closedLocal, "client wrote to a stream after closing its writer";
    st.nsent = st.nsent + 1;
    if (st.nsent == streamWidth) {
      isClose = true;   // half-close: our writer closes, reader stays open
      st.closedLocal = true;
    }
    streams[k] = st;
    return enqueueMsg(MSG_APP, p, st.sid, isOpen, isClose);
  }

  // C4-style inline invariant: never put an out-of-order seq on the wire.
  fun transmit(m: tMsg) {
    assert m.seqn <= seqSent + 1,
      format("client would send out-of-order seq {0}, seqSent {1}", m.seqn, seqSent);
    send conn, eSendMsg, (toServer = true, msg = m);
    seqSent = m.seqn;
  }

  // Mirrors SessionConnected.sendBufferedMessages: replay everything in order.
  fun replayBuffer() {
    var i: int;
    i = 0;
    while (i < sizeof(sendBuffer)) {
      transmit(sendBuffer[i]);
      i = i + 1;
    }
  }

  // Mirrors SessionConnected.updateBookkeeping.
  fun acceptMsg(m: tMsg) {
    ackNum = m.seqn + 1;
    if (m.ack > maxAckSeen) {
      maxAckSeen = m.ack;
    }
    while (sizeof(sendBuffer) > 0 && sendBuffer[0].seqn < m.ack) {
      sendBuffer -= (0);
    }
    assertBufferWindow(sendBuffer, seqNum, maxAckSeen);
    if (m.kind == MSG_APP) {
      trackResponseStream(m);
      announce eSpecDeliver, (atServer = false, payload = m.payload);
      if (m.payload in pendingCalls) {
        pendingCalls -= (m.payload);
        announce eSpecResolved, (payload = m.payload, ok = true);
        send orch, eCallResolved, (payload = m.payload, ok = true);
      }
    } else if (m.kind == MSG_ACK) {
      // TS: a passive (non-heartbeating) side echoes an inbound heartbeat
      transmit(enqueueMsg(MSG_ACK, 0, 0, false, false));
    } else if (m.kind == MSG_RH_REQ) {
      // re-run metadata construction asynchronously (the TS construct() gap):
      // the response send is bound to the session captured HERE
      send this, eConstructDone, (sessGen = sessCounter, defers = 2);
    } else {
      assert false, "client received a MSG_RH_RESP";
    }
  }

  // Half-close discipline on the response pipe: the server may write on a
  // stream WE half-closed (that is the point of half-close), but nothing may
  // arrive after the SERVER closed its writer.
  fun trackResponseStream(m: tMsg) {
    var k: int;
    var st: (sid: int, nsent: int, closedLocal: bool, serverClosed: bool);
    var ks: seq[int];
    var i: int;
    ks = keys(streams);
    i = 0;
    while (i < sizeof(ks)) {
      k = ks[i];
      st = streams[k];
      if (st.sid == m.sid) {
        assert !st.serverClosed,
          format("server nsent data on stream {0} after closing its writer", m.sid);
        if (m.sclose) {
          st.serverClosed = true;
          streams[k] = st;
        }
        return;
      }
      i = i + 1;
    }
    // response for a stream this session no longer knows: impossible, since
    // stream records live exactly as long as the session
    assert false, format("client received a response for unknown stream {0}", m.sid);
  }

  // TS handshakeExtensions.construct(): re-reads the (possibly refreshed)
  // credential. The nondeterministic bump models a token refresh.
  fun construct(): int {
    if ($) {
      credential = credential + 1;
    }
    return credential;
  }

  // Completion of the async construct() for a rehandshake response. If the
  // session it was bound to is gone, the bound send throws in TS — here we
  // silently drop, which is the OBSERVABLE fixed behavior (stale metadata
  // must not reach the replacement session).
  fun handleConstructDone(t: (sessGen: int, defers: int), canTransmit: bool) {
    var m: tMsg;
    if (t.defers > 0 && $) {
      send this, eConstructDone, (sessGen = t.sessGen, defers = t.defers - 1);
      return;
    }
    if (!hasSession || t.sessGen != sessCounter) {
      return;  // session replaced during construct(): bound send throws
    }
    m = enqueueMsg(MSG_RH_RESP, construct(), 0, false, false);
    if (canTransmit) {
      transmit(m);
    }
  }

  /******************************** byzantine ********************************/

  // T6: a misbehaving client emits extra bogus frames outside its own
  // bookkeeping. A duplicate (seq < server.ack, always) must be silently
  // dropped; a future seq (> server.ack, always) must make the server close
  // the CONNECTION while the session survives.
  fun maybeCorrupt() {
    var m: tMsg;
    if (corruptBudget <= 0 || connId == -1) {
      return;
    }
    if ($) {
      corruptBudget = corruptBudget - 1;
      if (maxAckSeen > 0 && $) {
        m = (seqn = maxAckSeen - 1, ack = ackNum, kind = MSG_APP, payload = 0,
             sid = 0, sopen = false, sclose = false);
      } else {
        m = (seqn = seqNum + 1, ack = ackNum, kind = MSG_APP, payload = 0,
             sid = 0, sopen = false, sclose = false);
      }
      send conn, eSendMsg, (toServer = true, msg = m);
    }
  }
}
