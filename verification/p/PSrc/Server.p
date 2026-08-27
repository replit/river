/*****************************************************************************
ServerTransport: the server-side session state machine.

The server never dials. It holds at most one session (single-client model)
in a data-driven `Running` state (the TS server juggles a live session plus
concurrent pending handshakes, so flat states don't fit). A connection in
TS's SessionWaitingForHandshake is implicit here: a WsConnection whose
handshake request hasn't been processed yet.

onHandshakeRequest implements the four connect cases of PROTOCOL.md /
transport/server.ts:
  1. transparent reconnect  — old session with the same id; reject
     SESSION_STATE_MISMATCH if the client or server is "in the future",
     else demote the old connection and adopt the new one with inherited
     seq/ack/sendBuffer
  2. hard reconnect         — old session with a DIFFERENT id: delete it,
     fall through
  3. unknown session        — no session but nonzero expected state: reject
     SESSION_STATE_MISMATCH (retriable)
  4. new session            — adopt the client-supplied session id, zero state

eRestart models a server that lost all state (forces case 2/3 on reconnect).
*****************************************************************************/

machine ServerTransport {
  var orch: machine;
  var timer: machine;
  var expectHonest: bool;  // false in byzantine scenarios (T6)

  var hasSession: bool;
  var sessId: int;
  var seqNum: int;
  var seqSent: int;
  var ackNum: int;
  var maxAckSeen: int;
  var sendBuffer: seq[tMsg];

  var conn: machine;
  var connId: int;  // -1 = session disconnected (grace running)
  var graceGen: int;

  var meta: int;              // stored handshake metadata (credential)
  var sessGen: int;           // session identity: bumped on destroy/create
  var connEpoch: int;         // Connected-state instance identity: bumped on
                              // every adopt/demote/close — models the TS
                              // linear-typed (consumable) session state object
  var rhOutstanding: bool;    // one rehandshake round in flight at a time
  var consumedGuardFixed: bool;
  var zeroStateGuardFixed: bool;
  // stream overlay: per wire stream id, opened/half-closed-by-client state.
  // Lives exactly as long as the session (cleared on destroy/create).
  var streams: map[int, (clientClosed: bool, echoed: int)];

  start state Boot {
    entry (cfg: tServerCfg) {
      orch = cfg.orch;
      expectHonest = cfg.expectHonest;
      consumedGuardFixed = cfg.consumedGuardFixed;
      zeroStateGuardFixed = cfg.zeroStateGuardFixed;
      timer = new EchoTimer(this);
      connId = -1;
      goto Running;
    }
  }

  state Running {
    on eDeliverHsReq do (h: tHsReq) { handleHandshake(h); }
    on eDeliverMsg do (w: tWireMsg) { handleMsg(w); }
    on eConnClosed do (cid: int) {
      if (hasSession && cid == connId) {
        connId = -1;
        connEpoch = connEpoch + 1;  // ConnectedToNoConnection consumes the state
        graceGen = graceGen + 1;
        send timer, eStartGrace, graceGen;
      }
    }
    on eGraceFired do (g: int) {
      if (hasSession && connId == -1 && g == graceGen) {
        destroySession();
      }
    }
    on eRestart do {
      if (hasSession) {
        destroySession();
      }
    }
    // Only the server actively heartbeats (TS startActiveHeartbeat). The
    // heartbeat is an AckBit control message through the NORMAL send path:
    // it consumes a seq and occupies the send buffer, exactly as in TS.
    on eHeartbeatNudge do {
      if (hasSession && connId != -1) {
        sendNow(MSG_ACK, 0);
      }
    }
    // Server-initiated credential refresh (TS scheduleRehandshake /
    // requestRehandshakeNow): a ControlRehandshakeRequest through the normal
    // seq/ack send path.
    on eRehandshakeNudge do {
      if (hasSession && connId != -1 && !rhOutstanding) {
        rhOutstanding = true;
        sendNow(MSG_RH_REQ, 0);
      }
    }
    on eValidateDone do (v: (sessGen: int, connEpoch: int, reject: bool, meta: int, defers: int)) {
      handleValidateDone(v);
    }
    on eShutdown do {
      if (hasSession) {
        destroySession();
      }
      announce eSpecClosed, true;
      goto Done;
    }
  }

  state Done {
    ignore eDeliverHsReq, eDeliverMsg, eConnClosed, eGraceFired, eRestart, eShutdown,
           eHeartbeatNudge, eRehandshakeNudge, eValidateDone;
  }

  /******************************** handshake ********************************/

  fun handleHandshake(h: tHsReq) {
    if (hasSession && sessId == h.sessionId) {
      // case 1: transparent reconnect to the existing session
      if (h.nextSentSeq > ackNum) {
        // client is in the future
        rejectRetriable(h);
        return;
      }
      if (nextSeqLocal() > h.nextExpectedSeq) {
        // server is in the future
        rejectRetriable(h);
        return;
      }
      if (connId != -1) {
        // demote the old live connection before adopting the new one
        send conn, eConnCloseCmd;
      }
      announce eSpecTransparentReconnect, (oldId = sessId, newId = h.sessionId);

      adoptConn(h);
      return;
    }
    if (hasSession) {
      // case 2: hard reconnect — the client wants a session we don't have
      destroySession();
    }
    if (h.nextSentSeq > 0 || h.nextExpectedSeq > 0
        || (zeroStateGuardFixed && h.isReconnect)) {
      // case 3: reconnect to an unknown session — nothing to salvage.
      // The isReconnect check closes the zero-state window: without it, a
      // reconnecting client that never received an ack is indistinguishable
      // from a new session and its replay re-delivers to handlers.
      rejectRetriable(h);
      return;
    }
    // case 4: new session, adopt the client-supplied id with zero state
    hasSession = true;
    sessGen = sessGen + 1;
    rhOutstanding = false;
    streams = default(map[int, (clientClosed: bool, echoed: int)]);
    sessId = h.sessionId;
    seqNum = 0;
    seqSent = -1;
    ackNum = 0;
    maxAckSeen = 0;
    sendBuffer = default(seq[tMsg]);
    adoptConn(h);
  }

  fun adoptConn(h: tHsReq) {
    if (connId != -1) {
      connEpoch = connEpoch + 1;  // demotion consumed the old Connected state
    }
    connId = h.connId;
    conn = h.conn;
    connEpoch = connEpoch + 1;    // a fresh Connected-state instance
    meta = h.meta;                // storeSessionMetadata (re-validated on every handshake)
    graceGen = graceGen + 1;  // cancel grace
    // Response first, then the buffer replay: FIFO through the connection
    // guarantees the client sees them in that order.
    send conn, eSendHsResp, (connId = h.connId, ok = true, sessionId = sessId, retriable = false);
    replayBuffer();
  }

  fun rejectRetriable(h: tHsReq) {
    send h.conn, eSendHsResp, (connId = h.connId, ok = false, sessionId = h.sessionId, retriable = true);
    // TS deletePendingSession closes the rejected connection
    send h.conn, eConnCloseCmd;
  }

  fun destroySession() {
    hasSession = false;
    sessGen = sessGen + 1;
    connEpoch = connEpoch + 1;
    rhOutstanding = false;
    streams = default(map[int, (clientClosed: bool, echoed: int)]);
    announce eSpecReset;
    if (connId != -1) {
      send conn, eConnCloseCmd;
      connId = -1;
    }
  }

  /********************************** wire ***********************************/

  fun nextSeqLocal(): int {
    if (sizeof(sendBuffer) > 0) {
      return sendBuffer[0].seqn;
    }
    return seqNum;
  }

  fun handleMsg(w: tWireMsg) {
    if (!hasSession || w.connId != connId) {
      return;  // stale connection or no session
    }
    if (w.msg.seqn < ackNum) {
      return;  // duplicate: silently discarded
    }
    if (w.msg.seqn > ackNum) {
      // TS logs `invariant-violation` and closes the CONNECTION to recover by
      // re-handshake with the session intact. Among honest peers this is
      // unreachable — asserting that is the model's C4 oracle.
      assert !expectHonest,
        format("server received out-of-order seq {0}, expected {1}", w.msg.seqn, ackNum);
      send conn, eConnCloseCmd;
      return;
    }
    // accept: mirrors SessionConnected.updateBookkeeping
    ackNum = w.msg.seqn + 1;
    if (w.msg.ack > maxAckSeen) {
      maxAckSeen = w.msg.ack;
    }
    while (sizeof(sendBuffer) > 0 && sendBuffer[0].seqn < w.msg.ack) {
      sendBuffer -= (0);
    }
    assertBufferWindow(sendBuffer, seqNum, maxAckSeen);
    if (w.msg.kind == MSG_APP) {
      trackRequestStream(w.msg);
      announce eSpecDeliver, (atServer = true, payload = w.msg.payload);
      // echo = the response; when the client half-closed and this is the last
      // echo, the server closes its writer too (full close, upload-style)
      sendNow2(MSG_APP, w.msg.payload, w.msg.sid, streams[w.msg.sid].clientClosed);
    } else if (w.msg.kind == MSG_RH_RESP) {
      // TS onRehandshakeResponse: the response arrived (deadline cleared),
      // then `await validate(...)` — an async gap during which the session
      // state captured here can be consumed by a transition. The reject
      // verdict models a custom validator rejecting the refreshed metadata.
      if (rhOutstanding) {
        rhOutstanding = false;
        send this, eValidateDone, (sessGen = sessGen, connEpoch = connEpoch,
                                   reject = $, meta = w.msg.payload, defers = 2);
      }
    }
    // an inbound MSG_ACK updates bookkeeping only; the active heartbeater
    // does not echo heartbeats back
  }

  // Completion of the async validate(). On success, TS stores the metadata
  // only if the session it validated against is still the live one. On
  // failure it calls teardownForFailedRehandshake — where d7c0ec9 lives:
  //   pre-fix:  `if (this.sessions.get(session.to) !== session) return;`
  //             reads `session.to` on a possibly-consumed state proxy, which
  //             THROWS (an unhandled rejection at runtime)
  //   post-fix: `if (session._isConsumed) return;` guards it first
  fun handleValidateDone(v: (sessGen: int, connEpoch: int, reject: bool, meta: int, defers: int)) {
    if (v.defers > 0 && $) {
      send this, eValidateDone, (sessGen = v.sessGen, connEpoch = v.connEpoch,
                                 reject = v.reject, meta = v.meta, defers = v.defers - 1);
      return;
    }
    if (!v.reject) {
      // only store if it's still the session (and state instance) we
      // validated against — don't clobber fresher metadata
      if (v.sessGen == sessGen && v.connEpoch == connEpoch) {
        meta = v.meta;
      }
      return;
    }
    // failed rehandshake: tear the session down
    if (consumedGuardFixed) {
      if (v.sessGen != sessGen || v.connEpoch != connEpoch) {
        return;  // d7c0ec9 guard: stale handle, cleanup belongs elsewhere
      }
    } else {
      assert v.sessGen == sessGen && v.connEpoch == connEpoch,
        "d7c0ec9: rehandshake teardown accessed a consumed session state (unhandled rejection in TS)";
    }
    if (hasSession) {
      destroySession();
    }
  }

  // B-series flag discipline on the request pipe: a stream MUST be opened by
  // its first message and only by its first message, and the client MUST NOT
  // write after closing its writer. (The seq layer dedups replays before this
  // runs, so a replayed OPEN after a transparent reconnect never reaches here
  // twice — but a bookkeeping bug that broke dedup would trip these.)
  fun trackRequestStream(m: tMsg) {
    var st: (clientClosed: bool, echoed: int);
    if (m.sopen) {
      assert !(m.sid in streams), format("stream {0} opened twice", m.sid);
      streams[m.sid] = (clientClosed = false, echoed = 0);
    } else {
      assert m.sid in streams, format("data on stream {0} before open", m.sid);
      assert !streams[m.sid].clientClosed,
        format("client data on stream {0} after its half-close", m.sid);
    }
    if (m.sclose) {
      st = streams[m.sid];
      st.clientClosed = true;
      streams[m.sid] = st;
    }
  }

  // The normal send path (consumes a seq, enters the send buffer, replayed on
  // reconnect). MSG_APP = the "rpc response" echo; MSG_ACK = a heartbeat.
  fun sendNow(kind: tMsgKind, p: int) {
    sendNow2(kind, p, 0, false);
  }

  fun sendNow2(kind: tMsgKind, p: int, sid: int, sclose: bool) {
    var m: tMsg;
    m = (seqn = seqNum, ack = ackNum, kind = kind, payload = p,
         sid = sid, sopen = false, sclose = sclose);
    seqNum = seqNum + 1;
    sendBuffer += (sizeof(sendBuffer), m);
    assertBufferWindow(sendBuffer, seqNum, maxAckSeen);
    if (connId != -1) {
      transmit(m);
    }
  }

  fun transmit(m: tMsg) {
    assert m.seqn <= seqSent + 1,
      format("server would send out-of-order seq {0}, seqSent {1}", m.seqn, seqSent);
    send conn, eSendMsg, (toServer = false, msg = m);
    seqSent = m.seqn;
  }

  fun replayBuffer() {
    var i: int;
    i = 0;
    while (i < sizeof(sendBuffer)) {
      transmit(sendBuffer[i]);
      i = i + 1;
    }
  }
}
