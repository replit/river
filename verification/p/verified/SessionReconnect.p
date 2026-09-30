/*****************************************************************************
Inductive proof that the isReconnect handshake guard closes the zero-state
duplicate-delivery window — for ALL executions (PVerifier: UCLID5 + Z3).

Beyond the seq/ack sliding window inside one session, this model covers where
the real bug lived: sessions, server state loss, handshakes, and
reconnection.

The client owns a current session (monotonically numbered `sid`), issues
globally-unique payloads (`base + seqn + 1`, with `base` ratcheting past every
issued payload on a hard reset — abandoned messages are never re-issued), and
may only transmit while connected. Handshake requests carry the session id,
the send-buffer head (`nextSentSeq`), and `isReconnect` — whether this session
was ever connected (the fix shipped in transport/: the session's
`hadConnection` bit). The server holds at most one session, may lose ALL
state at any moment (restart / grace expiry), accepts data only for its
current session at exactly `seqn == ackNum`, and handles handshakes with the
FIXED rule: a request for an unknown session is rejected when
`nextSentSeq > 0 || isReconnect` — the zero-state window is exactly the case
where only `isReconnect` distinguishes a doomed replay from a fresh session.

THE THEOREM (the in-handler asserts): the served application stream never
regresses — every delivered payload is strictly greater than the delivery
watermark W (no duplicate delivery, ever, across any number of resets,
losses, and reconnects), and consecutive deliveries within one session are
gap-free (payload == W + 1).

The proof leans on one load-bearing chain, which is the fix itself:
  data is only ever sent on a session that has connected (I6, lastConnSid)
  => a handshake with isReconnect == false is only in flight for sessions
     that never connected (I5)
  => accepting a session as NEW is safe: no data for it exists anywhere
  => every deliverable in-flight message is above the watermark (I10).
Deleting the isReconnect guard from handleHsReq makes I10 (and the theorem)
fail induction — the proof-level regression for this bug class.

Run:  p compile -pf SessionReconnect.p -pn RiverSessionReconnect -md verification
(inside `nix develop .#verification`)
*****************************************************************************/

event eMsg: (sid: int, seqn: int, payload: int);
event eAck: (sid: int, ack: int);
event eHsReq: (sid: int, nextSentSeq: int, isReconnect: bool);
event eHsOk: (sid: int);
event eHsReject: (sid: int);

machine ClientCore {
  var sid: int;          // current session id, monotonic (init 1)
  var base: int;         // payload offset: this session's payloads are base+1..
  var seqNum: int;       // next seq to assign in this session
  var bufLo: int;        // lowest unacked seq (send-buffer head)
  var retry: int;        // retransmit cursor (walks the window)
  var connected: bool;   // handshake completed on the current connection
  var hadConn: bool;     // this session ever connected (drives isReconnect)
  var awaitingHs: bool;  // at most one handshake request outstanding
  var sentFreshReq: bool; // this session's one fresh (isReconnect=false)
                          // handshake has been sent — at most one ever exists
  var lastConnSid: int;  // ghost: highest session id that ever connected

  start state Run {
    entry {
      // one nondeterministic action per step ($ cannot appear in compound
      // conditions in the verifier subset, hence the nested guards)
      if ($) {
        if (connected) {
          // fresh send: globally-unique payload, bound to (sid, seqn)
          send server(), eMsg, (sid = sid, seqn = seqNum, payload = base + seqNum + 1);
          seqNum = seqNum + 1;
        }
      } else if ($) {
        if (connected && bufLo < seqNum) {
          // retransmit any unacked message byte-identically (buffer replay)
          if (retry < bufLo || retry >= seqNum) {
            retry = bufLo;
          }
          send server(), eMsg, (sid = sid, seqn = retry, payload = base + retry + 1);
          if ($) {
            retry = retry + 1;
          }
        }
      } else if ($) {
        if (!connected && !awaitingHs) {
          if (hadConn || !sentFreshReq) {
            // (re)connect. nextSentSeq is the send-buffer head, isReconnect
            // is the hadConnection bit — the fix under proof. A session gets
            // exactly ONE fresh (isReconnect=false) handshake: in reality a
            // handshake request dies with its connection (sockets close,
            // pending sessions time out), so a fresh request can never
            // outlive the session's first connect; the untimed model folds
            // that into one-fresh-attempt-per-session (a never-connected
            // session that gives up resets instead, which reaches the same
            // states up to session renumbering).
            awaitingHs = true;
            sentFreshReq = true;
            send server(), eHsReq, (sid = sid, nextSentSeq = bufLo, isReconnect = hadConn);
          }
        }
      } else if ($) {
        if (connected) {
          // connection drop observed by the client. The outstanding-attempt
          // flag is NOT cleared here: a handshake request never outlives its
          // connection attempt in reality (sockets die with the connection
          // and pending sessions have a handshake timeout), which the model
          // folds into at-most-one-outstanding-attempt per session.
          connected = false;
        }
      } else if ($) {
        // hard reset: grace expiry / fatal rejection. Every issued payload of
        // this session is abandoned (resolved UNEXPECTED_DISCONNECT) and
        // never re-issued: base ratchets past all of them.
        newSession();
      }
      if ($) {
        goto Run;
      }
    }
    on eAck do (a: (sid: int, ack: int)) {
      // cumulative ack for the CURRENT session only (stale sessions' acks
      // arrive after a reset and must not touch the new session's window)
      if (a.sid == sid && a.ack > bufLo) {
        bufLo = a.ack;
      }
    }
    on eHsOk do (h: (sid: int)) {
      if (h.sid == sid) {
        connected = true;
        hadConn = true;
        awaitingHs = false;
        if (lastConnSid < sid) {
          lastConnSid = sid;
        }
      }
    }
    on eHsReject do (h: (sid: int)) {
      if (h.sid == sid) {
        // SESSION_STATE_MISMATCH: hard reset to a fresh session
        newSession();
      }
    }
  }

  fun newSession() {
    base = base + seqNum;
    sid = sid + 1;
    seqNum = 0;
    bufLo = 0;
    retry = 0;
    connected = false;
    hadConn = false;
    awaitingHs = false;
    sentFreshReq = false;
  }
}

machine ServerCore {
  var hasSess: bool;
  var cur: int;              // adopted session id
  var ackNum: int;           // next expected seq for cur
  var w: int;                // ghost: watermark = highest payload delivered
  var lastDelivSid: int;     // ghost: session of the most recent delivery
  var granted: set[int];     // ghost: sids ever sent an eHsOk

  start state Run {
    entry {
      if ($) {
        if (hasSess) {
          // total server state loss: restart or session grace expiry
          hasSess = false;
        }
      }
      if ($) {
        goto Run;
      }
    }
    on eHsReq do (h: (sid: int, nextSentSeq: int, isReconnect: bool)) {
      if (hasSess && cur == h.sid) {
        // transparent reconnect to the session we hold
        if (h.nextSentSeq > ackNum) {
          // client is in the future
          send client(), eHsReject, (sid = h.sid,);
        } else {
          granted += (h.sid);
          send client(), eHsOk, (sid = h.sid,);
        }
      } else if (h.nextSentSeq > 0 || h.isReconnect) {
        // THE FIX: an unknown session is rejected not only when the seq
        // counters are nonzero but also when the client marks the attempt as
        // a reconnection — the zero-state window is exactly
        // nextSentSeq == 0 && isReconnect == true
        send client(), eHsReject, (sid = h.sid,);
      } else {
        // new session (hard reconnect implicitly deletes any old one)
        hasSess = true;
        cur = h.sid;
        ackNum = 0;
        granted += (h.sid);
        send client(), eHsOk, (sid = h.sid,);
      }
    }
    on eMsg do (m: (sid: int, seqn: int, payload: int)) {
      if (hasSess && m.sid == cur && m.seqn == ackNum) {
        // THE THEOREM: the application stream never regresses...
        assert m.payload > w,
          "duplicate delivery: a payload at or below the watermark reached the application";
        // ...and within one session it is gap-free
        if (lastDelivSid == cur) {
          assert m.payload == w + 1,
            "delivery gap within a session";
        }
        w = m.payload;
        lastDelivSid = cur;
        ackNum = ackNum + 1;
        if ($) {
          send client(), eAck, (sid = cur, ack = ackNum);
        }
      }
      // otherwise: unknown/stale session or out-of-window seq — dropped
    }
  }
}

/**************************** system configuration ***************************/

pure client(): machine;
pure server(): machine;

init-condition forall (m: machine) :: m == client() <==> m is ClientCore;
init-condition forall (m: machine) :: m == server() <==> m is ServerCore;
init-condition forall (c: ClientCore) ::
  c.sid == 1 && c.base == 0 && c.seqNum == 0 && c.bufLo == 0 && c.retry == 0 &&
  !c.connected && !c.hadConn && !c.awaitingHs && !c.sentFreshReq &&
  c.lastConnSid == 0;
init-condition forall (s: ServerCore) ::
  !s.hasSess && s.cur == 0 && s.ackNum == 0 && s.w == 0 && s.lastDelivSid == 0 &&
  s.granted == default(set[int]);

/******************************** invariants *********************************/

Lemma reconnect {
  // configuration and routing
  invariant one_client: forall (m: machine) :: m == client() <==> m is ClientCore;
  invariant one_server: forall (m: machine) :: m == server() <==> m is ServerCore;
  invariant no_msg_to_client: forall (e: eMsg, c: ClientCore) :: e targets c ==> !inflight e;
  invariant no_hsreq_to_client: forall (e: eHsReq, c: ClientCore) :: e targets c ==> !inflight e;
  invariant no_ack_to_server: forall (e: eAck, s: ServerCore) :: e targets s ==> !inflight e;
  invariant no_hsok_to_server: forall (e: eHsOk, s: ServerCore) :: e targets s ==> !inflight e;
  invariant no_hsreject_to_server: forall (e: eHsReject, s: ServerCore) :: e targets s ==> !inflight e;

  // client-local structure
  invariant window_wf: forall (c: ClientCore) :: 0 <= c.bufLo && c.bufLo <= c.seqNum;
  invariant base_nonneg: forall (c: ClientCore) :: c.base >= 0;
  invariant sid_positive: forall (c: ClientCore) :: c.sid >= 1;
  invariant conn_ghost: forall (c: ClientCore) ::
    (c.hadConn ==> c.lastConnSid == c.sid) &&
    (!c.hadConn ==> c.lastConnSid < c.sid);
  invariant unconnected_fresh: forall (c: ClientCore) ::
    !c.hadConn ==> c.seqNum == 0 && c.bufLo == 0;
  invariant connected_implies_had: forall (c: ClientCore) :: c.connected ==> c.hadConn;

  // wire: current-session data is bound to the window and the payload line
  invariant cur_msg_binding: forall (e: eMsg, c: ClientCore) ::
    inflight e && e.sid == c.sid ==>
      e.payload == c.base + e.seqn + 1 && 0 <= e.seqn && e.seqn < c.seqNum;
  // wire: stale-session data is from the past — below the base ratchet
  invariant old_msg_bounded: forall (e: eMsg, c: ClientCore) ::
    inflight e && e.sid != c.sid ==> e.sid < c.sid && e.payload <= c.base;
  // data only ever exists for sessions that connected (transmit gating)
  invariant sent_needs_connection: forall (e: eMsg, c: ClientCore) ::
    inflight e ==> e.sid <= c.lastConnSid;
  // a handshake claiming "not a reconnect" carries a zero send-buffer head
  // (an unconnected session has never transmitted)
  invariant fresh_hsreq_honest: forall (e: eHsReq, c: ClientCore) ::
    inflight e && !e.isReconnect ==> e.nextSentSeq == 0;
  // ...and there is at most one such request per session, ever (one-shot)
  invariant fresh_unique: forall (e1: eHsReq, e2: eHsReq) ::
    inflight e1 && inflight e2 && !e1.isReconnect && !e2.isReconnect &&
    e1.sid == e2.sid ==> e1 == e2;
  invariant fresh_oneshot: forall (e: eHsReq, c: ClientCore) ::
    inflight e && !e.isReconnect && e.sid == c.sid ==> c.sentFreshReq && !c.hadConn;
  invariant true_req_had: forall (e: eHsReq, c: ClientCore) ::
    inflight e && e.isReconnect && e.sid == c.sid ==> c.hadConn;
  // grant bookkeeping: an eHsOk exists only for granted sids, a granted sid
  // has consumed its fresh request, and grants never outrun the client
  invariant hsok_granted: forall (r: eHsOk, s: ServerCore) ::
    inflight r ==> r.sid in s.granted;
  invariant fresh_not_granted: forall (e: eHsReq, s: ServerCore) ::
    inflight e && !e.isReconnect ==> !(e.sid in s.granted);
  invariant granted_known: forall (c: ClientCore, s: ServerCore) ::
    c.sid in s.granted ==> c.sentFreshReq || c.hadConn;
  invariant granted_bounded: forall (c: ClientCore, s: ServerCore, x: int) ::
    x in s.granted ==> x <= c.sid;
  // the granted ghost is the connection witness: data, connected state, the
  // held session, reconnect-flagged requests, and past deliveries all imply
  // membership; a fresh request implies NON-membership (fresh_not_granted),
  // so accepting a session as new is provably safe
  invariant msgs_granted: forall (e: eMsg, s: ServerCore) ::
    inflight e ==> e.sid in s.granted;
  invariant connected_granted: forall (c: ClientCore, s: ServerCore) ::
    c.hadConn ==> c.sid in s.granted;
  invariant cur_granted: forall (s: ServerCore) ::
    s.hasSess ==> s.cur in s.granted;
  invariant true_req_granted: forall (e: eHsReq, s: ServerCore) ::
    inflight e && e.isReconnect ==> e.sid in s.granted;
  invariant deliv_granted: forall (s: ServerCore) ::
    s.lastDelivSid == 0 || s.lastDelivSid in s.granted;
  invariant hsreq_sid_bounded: forall (e: eHsReq, c: ClientCore) ::
    inflight e ==> e.sid <= c.sid;

  // acks describe real receiver progress of the session they name
  invariant ack_bounded: forall (e: eAck, c: ClientCore, s: ServerCore) ::
    inflight e && e.sid == c.sid ==> e.ack <= c.seqNum;

  // server/client window relations while the server holds the live session
  invariant recv_le_sent: forall (c: ClientCore, s: ServerCore) ::
    s.hasSess && s.cur == c.sid ==> 0 <= s.ackNum && s.ackNum <= c.seqNum;
  invariant watermark_le_issued: forall (c: ClientCore, s: ServerCore) ::
    s.w <= c.base + c.seqNum;
  invariant watermark_cur: forall (c: ClientCore, s: ServerCore) ::
    s.hasSess && s.cur == c.sid ==> s.w <= c.base + s.ackNum;
  invariant deliv_ghost: forall (c: ClientCore, s: ServerCore) ::
    s.lastDelivSid <= c.lastConnSid;
  invariant watermark_cur_tight: forall (c: ClientCore, s: ServerCore) ::
    s.hasSess && s.cur == c.sid && s.lastDelivSid == s.cur ==>
      s.w == c.base + s.ackNum;

  // messages of one session lie on one payload line (retransmits are
  // byte-identical), so deliveries on a stale session stay ordered too
  invariant same_sid_linear: forall (e1: eMsg, e2: eMsg) ::
    inflight e1 && inflight e2 && e1.sid == e2.sid ==>
      e1.payload - e1.seqn == e2.payload - e2.seqn;
  // if the last delivery was on the currently-held session, the watermark
  // sits exactly at that session's line at ackNum (stale or current)
  invariant line_tight: forall (e: eMsg, s: ServerCore) ::
    inflight e && s.hasSess && e.sid == s.cur && s.lastDelivSid == s.cur ==>
      s.w == e.payload - e.seqn + s.ackNum - 1;

  // THE MASTER INVARIANT: anything the server could deliver next is above
  // the watermark — duplicates are unreachable
  invariant deliverable_above_watermark: forall (e: eMsg, s: ServerCore, c: ClientCore) ::
    inflight e && s.hasSess && e.sid == s.cur && e.seqn >= s.ackNum ==>
      e.payload > s.w;
}

Proof {
  prove reconnect;
  prove default using reconnect;
}
