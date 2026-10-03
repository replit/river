// -*- mode: Bluespec; -*-

/// Executable model of the River protocol (PROTOCOL.md, v2.0).
///
/// One client transport and one server transport talk over a network that can
/// delay, drop, and corrupt frames, break connections, and deliver close events
/// late. The server can restart (losing all state) and the client can hard
/// disconnect. Above the session layer, the model runs the four procedure types
/// with their close, cancel, and teardown rules.
///
/// Timers carry explicit deadlines and creation order, mirroring how the
/// TypeScript transports schedule them, so every trace this model produces can
/// be replayed step by step against the real implementation under fake timers.
/// `__tests__/conformance` does exactly that: the model is both the protocol
/// specification checked by `quint run` and the oracle for the implementation.
module river {
  //////////////////////////////////////////////////////////////////////////////
  // Types
  //////////////////////////////////////////////////////////////////////////////

  type Option[a] = Some(a) | None

  type Cfg = {
    grace: int,
    connectTimeout: int,
    handshakeTimeout: int,
    backoff: int,
    heartbeat: int,
    heartbeatsUntilDead: int,
    maxStreams: int,
    maxWrites: int,
  }

  /// A pending timer. Timers due at the same instant fire in creation order.
  type Timer = { at: int, id: int }

  type ProcType = PRpc | PStream | PUpload | PSubscription

  /// A value pushed into a Readable.
  type Res = ROk(int) | RErr(str)

  /// Payloads of sequenced transport messages ("Lifetime of streams").
  type Body =
    // AckBit heartbeat
    | Heartbeat
    // StreamOpenBit, plus StreamClosedBit for rpc and subscription
    | SInit({ sid: int, pt: ProcType, close: bool })
    // client request data, no control flags
    | SData({ sid: int, v: int })
    // server Ok result, StreamClosedBit for rpc and upload
    | SResult({ sid: int, v: int, close: bool })
    // ControlClose with StreamClosedBit, either direction
    | SClose(int)
    // StreamCancelBit with a ProtocolError, either direction
    | SCancel({ sid: int, code: str })

  /// `sess` is bookkeeping only: the session incarnation that sent the message.
  type Msg = { seq: int, ack: int, body: Body, sess: int }

  type HsReqFrame = { sess: int, nextExpectedSeq: int, nextSentSeq: int }
  type HsRespFrame = { ok: bool, sess: int, code: str }

  type Frame = HsReq(HsReqFrame) | HsResp(HsRespFrame) | Data(Msg)

  /// A wire connection. Once closed (by either side or by the network), later
  /// sends are discarded, like WebSocket.send on a closing socket. Frames
  /// already in flight may still arrive until that side's close event.
  type Conn = {
    toServer: List[Frame],
    toClient: List[Frame],
    closed: bool,
    clientEv: bool,
    serverEv: bool,
  }

  /// Client session states; the dial or connection each one is waiting on.
  type CState = CNoConn | CBackingOff | CConnecting(int) | CHandshaking(int) | CConnected(int)

  type ClientSession = {
    sess: int,
    st: CState,
    seq: int,
    ack: int,
    seqSent: int,
    buf: List[Msg],
    grace: Option[Timer],
    // backoff, connection timeout, or handshake timeout depending on `st`
    stTimer: Option[Timer],
    wd: Option[Timer],
    lastInbound: int,
  }

  type ClientT = {
    session: Option[ClientSession],
    // LeakyBucketRateLimit budget consumed; never restored in this configuration
    attempts: int,
    // the budget restore interval is pending
    restoreActive: bool,
  }

  /// A server connection in WaitingForHandshake.
  type Pending = { hs: Timer, gotHandshake: bool }

  type SState = SNoConn | SConnected(int)

  type ServerSession = {
    sess: int,
    st: SState,
    seq: int,
    ack: int,
    seqSent: int,
    buf: List[Msg],
    grace: Option[Timer],
    wd: Option[Timer],
    hb: Option[Timer],
    lastInbound: int,
  }

  type ServerT = {
    pending: int -> Pending,
    session: Option[ServerSession],
    // the router's cancelled-stream tombstones for this client
    tombstones: Set[int],
    epoch: int,
    // ServerTransport.close() was called; the process keeps running
    closed: bool,
  }

  /// Client half of a procedure stream (router/client.ts).
  type CStream = {
    pt: ProcType,
    sess: int,
    w: bool,
    r: bool,
    clean: bool,
    listening: bool,
    aborted: bool,
    results: List[Res],
    written: List[int],
    gotCancel: bool,
    sentClose: bool,
  }

  /// Server half of a procedure stream (router/server.ts).
  type SStream = {
    pt: ProcType,
    sess: int,
    r: bool,
    w: bool,
    clean: bool,
    inMap: bool,
    handlerDone: bool,
    values: List[Res],
    written: List[int],
    gotCancel: bool,
    sentClose: bool,
  }

  /// Observations the invariants and the conformance harness read.
  type Obs = {
    // protocolError events, by type
    cErrs: List[str],
    sErrs: List[str],
    // out-of-order receipts (each logs an invariant-violation)
    cOoo: int,
    sOoo: int,
    // why the server rejected handshakes
    rejections: List[str],
    crossSession: bool,
    ackBeyondSent: bool,
    sendOrder: bool,
    sentAfterCancel: bool,
    sentAfterClose: bool,
  }

  type Ids = { sess: int, conn: int, dial: int, stream: int, timer: int }

  type State = {
    cfg: Cfg,
    now: int,
    // inside a timer callback, where a zero delay schedules one tick later
    inTimer: bool,
    ids: Ids,
    client: ClientT,
    server: ServerT,
    conns: int -> Conn,
    dials: Set[int],
    cStreams: int -> CStream,
    sStreams: int -> SStream,
    obs: Obs,
  }

  type TimerRef =
    | TClientGrace
    | TClientState
    | TClientWd
    | TPendingHs(int)
    | TServerGrace
    | TServerWd
    | TServerHb

  type Action =
    | AInit
    | AInvoke({ sid: int, pt: ProcType })
    | AWrite({ sid: int, v: int })
    | AClose(int)
    | ACancel(int)
    | ARespond({ sid: int, v: int })
    | ASWrite({ sid: int, v: int })
    | ASClose(int)
    | ASCancel(int)
    | AThrow(int)
    | ADeliver({ conn: int, toServer: bool })
    | ADrop({ conn: int, toServer: bool })
    | ABreak(int)
    | ACloseEvent({ conn: int, server: bool })
    | AGarbage({ conn: int, server: bool })
    | ADialOk(int)
    | ADialFail(int)
    | ATick(int)
    | AFire(TimerRef)
    | ARestart
    | AServerClose
    | AHardDisconnect

  //////////////////////////////////////////////////////////////////////////////
  // Configuration
  //////////////////////////////////////////////////////////////////////////////

  /// Distinct, mostly prime durations keep timer ties rare. The grace period
  /// exceeds connectTimeout + handshakeTimeout, as SessionOptions recommends.
  pure val CFG: Cfg = {
    grace: 401,
    connectTimeout: 113,
    handshakeTimeout: 139,
    backoff: 23,
    heartbeat: 97,
    heartbeatsUntilDead: 2,
    maxStreams: 3,
    maxWrites: 2,
  }

  pure val TICKS = Set(1, 7, 29, 61)

  pure val SESSION_STATE_MISMATCH = "SESSION_STATE_MISMATCH"
  pure val HANDSHAKE_FAILED = "handshake_failed"
  pure val INVALID_MESSAGE = "invalid_message"

  //////////////////////////////////////////////////////////////////////////////
  // Helpers
  //////////////////////////////////////////////////////////////////////////////

  pure def max(a: int, b: int): int = if (a > b) a else b

  pure def isSomeTimer(o: Option[Timer]): bool = match o {
    | Some(_) => true
    | None => false
  }

  pure def removeKey(m: int -> Pending, k: int): int -> Pending =
    m.keys().exclude(Set(k)).mapBy(x => m.get(x))

  /// Schedules a timer. Delays clamp at zero, and like the fake clock the
  /// conformance harness uses, a zero delay inside a timer callback lands one
  /// tick later. `id` is the scheduling order that breaks ties between timers
  /// due at the same instant.
  pure def allocTimer(s: State, at: int): { s: State, t: Timer } = {
    val delay = max(0, at - s.now)
    val effective = if (delay == 0 and s.inTimer) 1 else delay
    {
      s: { ...s, ids: { ...s.ids, timer: s.ids.timer + 1 } },
      t: { at: s.now + effective, id: s.ids.timer },
    }
  }

  /// An interval re-arms by its period and, like a freshly scheduled timer,
  /// takes the latest scheduling order.
  pure def rearmInterval(s: State, t: Timer): { s: State, t: Timer } = {
    s: { ...s, ids: { ...s.ids, timer: s.ids.timer + 1 } },
    t: { at: t.at + s.cfg.heartbeat, id: s.ids.timer },
  }

  pure def setClient(s: State, cs: Option[ClientSession]): State =
    { ...s, client: { ...s.client, session: cs } }

  pure def setServer(s: State, ss: Option[ServerSession]): State =
    { ...s, server: { ...s.server, session: ss } }

  pure def setCStream(s: State, sid: int, c: CStream): State =
    { ...s, cStreams: s.cStreams.set(sid, c) }

  pure def setSStream(s: State, sid: int, x: SStream): State =
    { ...s, sStreams: s.sStreams.set(sid, x) }

  pure def addCErr(s: State, e: str): State =
    { ...s, obs: { ...s.obs, cErrs: s.obs.cErrs.append(e) } }

  pure def addSErr(s: State, e: str): State =
    { ...s, obs: { ...s.obs, sErrs: s.obs.sErrs.append(e) } }

  pure def graceAt(o: Option[Timer], fallback: int): int = match o {
    | Some(t) => t.at
    | None => fallback
  }

  /// IdentifiedSession.nextSeq: the first seq a reconnect would (re)send.
  pure def nextSeq(buf: List[Msg], seq: int): int =
    if (buf.length() > 0) buf[0].seq else seq

  pure def bodySid(b: Body): int = match b {
    | Heartbeat => -1
    | SInit(x) => x.sid
    | SData(x) => x.sid
    | SResult(x) => x.sid
    | SClose(x) => x
    | SCancel(x) => x.sid
  }

  pure def isCancelBody(b: Body): bool = match b {
    | SCancel(_) => true
    | _ => false
  }

  pure def closesWithInit(pt: ProcType): bool = pt == PRpc or pt == PSubscription

  pure def closesWithResponse(pt: ProcType): bool = pt == PRpc or pt == PUpload

  pure def acceptsRequests(pt: ProcType): bool = pt == PStream or pt == PUpload

  pure def oks(l: List[Res]): List[int] =
    l.foldl([], (acc, r) => match r {
      | ROk(v) => acc.append(v)
      | RErr(_) => acc
    })

  pure def isPrefix(a: List[int], b: List[int]): bool =
    a.length() <= b.length() and a.indices().forall(i => a[i] == b[i])

  pure def bufHas(buf: List[Msg], k: int): bool =
    buf.foldl(false, (acc, m) => acc or m.seq == k)

  pure def bufCovers(buf: List[Msg], lo: int, hi: int): bool =
    lo >= hi or range(lo, hi).foldl(true, (acc, k) => acc and bufHas(buf, k))

  //////////////////////////////////////////////////////////////////////////////
  // Network
  //////////////////////////////////////////////////////////////////////////////

  pure def push(s: State, c: int, toServer: bool, f: Frame): State = {
    val cn = s.conns.get(c)
    if (cn.closed) s
    else if (toServer) { ...s, conns: s.conns.set(c, { ...cn, toServer: cn.toServer.append(f) }) }
    else { ...s, conns: s.conns.set(c, { ...cn, toClient: cn.toClient.append(f) }) }
  }

  pure def closeConn(s: State, c: int): State =
    { ...s, conns: s.conns.set(c, { ...s.conns.get(c), closed: true }) }

  //////////////////////////////////////////////////////////////////////////////
  // Session layer: sending
  //////////////////////////////////////////////////////////////////////////////

  /// SessionConnected.send / IdentifiedSession.send on the client: every
  /// message gets the next seq and stays buffered until acknowledged.
  pure def clientSend(s: State, body: Body): State = match s.client.session {
    | None => s
    | Some(cs) => {
      val m = { seq: cs.seq, ack: cs.ack, body: body, sess: cs.sess }
      val cs1 = { ...cs, seq: cs.seq + 1, buf: cs.buf.append(m) }
      match cs.st {
        | CConnected(c) => {
          val s1 = if (m.seq > cs.seqSent + 1) { ...s, obs: { ...s.obs, sendOrder: true } } else s
          setClient(push(s1, c, true, Data(m)), Some({ ...cs1, seqSent: m.seq }))
        }
        | _ => setClient(s, Some(cs1))
      }
    }
  }

  pure def serverSend(s: State, body: Body): State = match s.server.session {
    | None => s
    | Some(ss) => {
      val m = { seq: ss.seq, ack: ss.ack, body: body, sess: ss.sess }
      val ss1 = { ...ss, seq: ss.seq + 1, buf: ss.buf.append(m) }
      match ss.st {
        | SConnected(c) => {
          val s1 = if (m.seq > ss.seqSent + 1) { ...s, obs: { ...s.obs, sendOrder: true } } else s
          setServer(push(s1, c, false, Data(m)), Some({ ...ss1, seqSent: m.seq }))
        }
        | SNoConn => setServer(s, Some(ss1))
      }
    }
  }

  pure def resendStep(acc: { s: State, seqSent: int }, m: Msg, c: int, toServer: bool): { s: State, seqSent: int } = {
    val s1 = if (m.seq > acc.seqSent + 1) { ...acc.s, obs: { ...acc.s.obs, sendOrder: true } } else acc.s
    { s: push(s1, c, toServer, Data(m)), seqSent: m.seq }
  }

  /// SessionConnected.sendBufferedMessages after a (re)handshake.
  pure def clientSendBuffered(s: State): State = match s.client.session {
    | Some(cs) => match cs.st {
      | CConnected(c) => {
        val r = cs.buf.foldl({ s: s, seqSent: cs.seqSent }, (acc, m) => resendStep(acc, m, c, true))
        setClient(r.s, Some({ ...cs, seqSent: r.seqSent }))
      }
      | _ => s
    }
    | None => s
  }

  pure def serverSendBuffered(s: State): State = match s.server.session {
    | Some(ss) => match ss.st {
      | SConnected(c) => {
        val r = ss.buf.foldl({ s: s, seqSent: ss.seqSent }, (acc, m) => resendStep(acc, m, c, false))
        setServer(r.s, Some({ ...ss, seqSent: r.seqSent }))
      }
      | SNoConn => s
    }
    | None => s
  }

  //////////////////////////////////////////////////////////////////////////////
  // Router: client side (router/client.ts)
  //////////////////////////////////////////////////////////////////////////////

  pure def clientStreamSend(s: State, sid: int, body: Body, isClose: bool): State = {
    val c = s.cStreams.get(sid)
    val o1 = if (c.gotCancel) { ...s.obs, sentAfterCancel: true } else s.obs
    val o2 = if (c.sentClose and not(isCancelBody(body))) { ...o1, sentAfterClose: true } else o1
    val s1 = { ...s, obs: o2 }
    val s2 = if (isClose) setCStream(s1, sid, { ...c, sentClose: true }) else s1
    clientSend(s2, body)
  }

  /// Readable closes; listeners are removed once both halves are closed.
  pure def cCloseReadable(c: CStream): CStream =
    { ...c, r: false, listening: if (not(c.w)) false else c.listening }

  /// onSessionStatus('closing') for one stream: UNEXPECTED_DISCONNECT.
  pure def cStreamOnClosing(s: State, sid: int, sess: int): State = {
    val c = s.cStreams.get(sid)
    if (not(c.listening) or c.sess != sess) s
    else {
      val res = if (c.r) c.results.append(RErr("UNEXPECTED_DISCONNECT")) else c.results
      setCStream(s, sid, { ...c, clean: false, r: false, w: false, listening: false, results: res })
    }
  }

  pure def clientRouterRecv(s: State, b: Body): State = {
    val sid = bodySid(b)
    if (not(s.cStreams.keys().contains(sid))) s
    else {
      val c = s.cStreams.get(sid)
      if (not(c.listening)) s
      else match b {
        | SCancel(x) => {
          val res = if (c.r) c.results.append(RErr(x.code)) else c.results
          setCStream(s, sid, { ...c, clean: false, gotCancel: true, r: false, w: false, listening: false, results: res })
        }
        | SResult(x) =>
          if (not(c.r)) s
          else {
            val c1 = { ...c, results: c.results.append(ROk(x.v)) }
            setCStream(s, sid, if (x.close) cCloseReadable(c1) else c1)
          }
        | SClose(_) => if (not(c.r)) s else setCStream(s, sid, cCloseReadable(c))
        | _ => s
      }
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  // Router: server side (router/server.ts)
  //////////////////////////////////////////////////////////////////////////////

  pure def serverStreamSend(s: State, sid: int, body: Body, isClose: bool): State = {
    val x = s.sStreams.get(sid)
    val o1 = if (x.gotCancel) { ...s.obs, sentAfterCancel: true } else s.obs
    val o2 = if (x.sentClose and not(isCancelBody(body))) { ...o1, sentAfterClose: true } else o1
    val s1 = { ...s, obs: o2 }
    val s2 = if (isClose) setSStream(s1, sid, { ...x, sentClose: true }) else s1
    serverSend(s2, body)
  }

  pure def sCloseReadable(x: SStream): SStream =
    { ...x, r: false, inMap: if (not(x.w)) false else x.inMap }

  /// resWritable.close(): stream and subscription announce the close unless
  /// the stream ended abruptly; rpc and upload already closed with the result.
  pure def serverCloseWritable(s: State, sid: int): State = {
    val x = s.sStreams.get(sid)
    if (not(x.w)) s
    else {
      val s1 = setSStream(s, sid, { ...x, w: false })
      val s2 = if (not(closesWithResponse(x.pt)) and x.clean) serverStreamSend(s1, sid, SClose(sid), true) else s1
      val x2 = s2.sStreams.get(sid)
      if (not(x2.r)) setSStream(s2, sid, { ...x2, inMap: false }) else s2
    }
  }

  /// onServerCancel: abrupt full close plus a cancel to the client.
  pure def serverOnCancel(s: State, sid: int, code: str): State = {
    val x = s.sStreams.get(sid)
    if (not(x.r) and not(x.w)) s
    else {
      val x1 = { ...x, clean: false }
      val x2 = if (x1.r) sCloseReadable({ ...x1, values: x1.values.append(RErr(code)) }) else x1
      val s1 = serverCloseWritable(setSStream(s, sid, x2), sid)
      val s2 = { ...s1, server: { ...s1.server, tombstones: s1.server.tombstones.union(Set(sid)) } }
      serverStreamSend(s2, sid, SCancel({ sid: sid, code: code }), false)
    }
  }

  pure def serverStreamHandle(s: State, sid: int, b: Body): State = {
    val x = s.sStreams.get(sid)
    match b {
      | SCancel(y) => {
        val x1 = { ...x, gotCancel: true }
        val x2 = if (x1.r) sCloseReadable({ ...x1, values: x1.values.append(RErr(y.code)) }) else x1
        serverCloseWritable(setSStream(s, sid, x2), sid)
      }
      | SData(y) =>
        if (x.r and acceptsRequests(x.pt)) setSStream(s, sid, { ...x, values: x.values.append(ROk(y.v)) })
        else serverOnCancel(s, sid, "INVALID_REQUEST")
      | SClose(_) =>
        if (x.r) setSStream(s, sid, sCloseReadable(x)) else serverOnCancel(s, sid, "INVALID_REQUEST")
      | _ => serverOnCancel(s, sid, "INVALID_REQUEST")
    }
  }

  pure def serverOpenStream(s: State, sid: int, pt: ProcType, close: bool): State = {
    val sess = match s.server.session {
      | Some(ss) => ss.sess
      | None => 0
    }
    val x = {
      pt: pt,
      sess: sess,
      r: not(close),
      w: true,
      clean: true,
      inMap: true,
      handlerDone: false,
      values: [],
      written: [],
      gotCancel: false,
      sentClose: false,
    }
    { ...s, sStreams: s.sStreams.put(sid, x) }
  }

  pure def serverRouterRecv(s: State, b: Body): State = {
    val sid = bodySid(b)
    val known = s.sStreams.keys().contains(sid) and s.sStreams.get(sid).inMap
    if (known) serverStreamHandle(s, sid, b)
    else if (s.server.tombstones.contains(sid)) s
    else match b {
      | SInit(x) => serverOpenStream(s, x.sid, x.pt, x.close)
      | _ => {
        // validateNewProcStream: no StreamOpenBit on an unknown stream
        val s1 = { ...s, server: { ...s.server, tombstones: s.server.tombstones.union(Set(sid)) } }
        serverSend(s1, SCancel({ sid: sid, code: "INVALID_REQUEST" }))
      }
    }
  }

  pure def sStreamOnClosing(s: State, sid: int): State = {
    val x = s.sStreams.get(sid)
    if (not(x.inMap)) s
    else {
      val v = if (x.r) x.values.append(RErr("UNEXPECTED_DISCONNECT")) else x.values
      setSStream(s, sid, { ...x, clean: false, r: false, w: false, inMap: false, values: v })
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  // Session lifecycle: client (transport/client.ts)
  //////////////////////////////////////////////////////////////////////////////

  pure def clientCreateSession(s: State): State = {
    val g = allocTimer(s, s.now + s.cfg.grace)
    val s1 = { ...g.s, ids: { ...g.s.ids, sess: g.s.ids.sess + 1 } }
    setClient(s1, Some({
      sess: s.ids.sess,
      st: CNoConn,
      seq: 0,
      ack: 0,
      seqSent: 0,
      buf: [],
      grace: Some(g.t),
      stTimer: None,
      wd: None,
      lastInbound: s.now,
    }))
  }

  /// ClientTransport.connect: create a session if needed, then back off.
  pure def clientConnect(s: State): State = {
    val s1 = match s.client.session {
      | Some(_) => s
      | None => clientCreateSession(s)
    }
    match s1.client.session {
      | Some(cs) =>
        if (cs.st == CNoConn) {
          val backoff = if (s1.client.attempts == 0) 0 else s1.cfg.backoff
          val s2 = { ...s1, client: { ...s1.client, attempts: s1.client.attempts + 1, restoreActive: false } }
          // SessionBackingOff re-arms the carried grace deadline, then the backoff
          val g = allocTimer(s2, max(s2.now, graceAt(cs.grace, s2.now)))
          val b = allocTimer(g.s, g.s.now + backoff)
          setClient(b.s, Some({ ...cs, st: CBackingOff, grace: Some(g.t), stTimer: Some(b.t) }))
        } else s1
      | None => s1
    }
  }

  /// Transport.deleteSession on the client: every stream bound to the session
  /// resolves with UNEXPECTED_DISCONNECT, then the session closes its connection.
  pure def clientDeleteSession(s: State): State = match s.client.session {
    | None => s
    | Some(cs) => {
      val s1 = s.cStreams.keys().fold(s, (acc, sid) => cStreamOnClosing(acc, sid, cs.sess))
      val s2 = match cs.st {
        | CHandshaking(c) => closeConn(s1, c)
        | CConnected(c) => closeConn(s1, c)
        | _ => s1
      }
      setClient(s2, None)
    }
  }

  /// onConnClosed: Handshaking or Connected to NoConnection, then reconnect.
  pure def clientConnLost(s: State): State = match s.client.session {
    | Some(cs) => match cs.st {
      | CHandshaking(c) => {
        val s1 = closeConn(s, c)
        val g = allocTimer(s1, max(s1.now, graceAt(cs.grace, s1.now)))
        clientConnect(setClient(g.s, Some({ ...cs, st: CNoConn, grace: Some(g.t), stTimer: None })))
      }
      | CConnected(c) => {
        val s1 = closeConn(s, c)
        val g = allocTimer(s1, s1.now + s1.cfg.grace)
        clientConnect(setClient(g.s, Some({ ...cs, st: CNoConn, grace: Some(g.t), stTimer: None, wd: None })))
      }
      | _ => s
    }
    | None => s
  }

  /// onConnectingFailed: dial failure or connection timeout.
  pure def clientConnectingFailed(s: State): State = match s.client.session {
    | Some(cs) => match cs.st {
      | CConnecting(_) => {
        val g = allocTimer(s, max(s.now, graceAt(cs.grace, s.now)))
        clientConnect(setClient(g.s, Some({ ...cs, st: CNoConn, grace: Some(g.t), stTimer: None })))
      }
      | _ => s
    }
    | None => s
  }

  /// onBackoffFinished: dial, then wait in Connecting.
  pure def clientBackoffDone(s: State): State = match s.client.session {
    | Some(cs) => {
      val d = s.ids.dial
      val s1 = { ...s, ids: { ...s.ids, dial: d + 1 }, dials: s.dials.union(Set(d)) }
      val g = allocTimer(s1, max(s1.now, graceAt(cs.grace, s1.now)))
      val t = allocTimer(g.s, g.s.now + g.s.cfg.connectTimeout)
      setClient(t.s, Some({ ...cs, st: CConnecting(d), grace: Some(g.t), stTimer: Some(t.t) }))
    }
    | None => s
  }

  pure def clientOnHsResp(s: State, r: HsRespFrame): State = match s.client.session {
    | Some(cs) =>
      if (not(r.ok)) {
        val s1 = clientDeleteSession(s)
        if (r.code == SESSION_STATE_MISMATCH) clientConnect(s1) else addCErr(s1, HANDSHAKE_FAILED)
      } else if (r.sess != cs.sess) clientDeleteSession(s)
      else match cs.st {
        | CHandshaking(c) => {
          val w = allocTimer(s, s.now + s.cfg.heartbeat)
          val s1 = setClient(w.s, Some({ ...cs, st: CConnected(c), grace: None, stTimer: None, wd: Some(w.t), lastInbound: w.s.now }))
          val s2 = clientSendBuffered(s1)
          { ...s2, client: { ...s2.client, restoreActive: true } }
        }
        | _ => s
      }
    | None => s
  }

  /// SessionConnected.onMessageData on the client.
  pure def clientRecvData(s: State, m: Msg): State = match s.client.session {
    | Some(cs) => match cs.st {
      | CConnected(c) =>
        if (m.seq < cs.ack) s
        else if (m.seq > cs.ack) closeConn({ ...s, obs: { ...s.obs, cOoo: s.obs.cOoo + 1 } }, c)
        else {
          val cs1 = { ...cs, buf: cs.buf.select(x => x.seq >= m.ack), ack: m.seq + 1, lastInbound: s.now }
          val o1 = if (m.sess != cs.sess) { ...s.obs, crossSession: true } else s.obs
          val o2 = if (m.ack > cs.seq) { ...o1, ackBeyondSent: true } else o1
          val s1 = setClient({ ...s, obs: o2 }, Some(cs1))
          match m.body {
            // passive heartbeating: echo every heartbeat
            | Heartbeat => clientSend(s1, Heartbeat)
            | _ => clientRouterRecv(s1, m.body)
          }
        }
      | _ => s
    }
    | None => s
  }

  //////////////////////////////////////////////////////////////////////////////
  // Session lifecycle: server (transport/server.ts)
  //////////////////////////////////////////////////////////////////////////////

  pure def deletePending(s: State, c: int): State = {
    val s1 = closeConn(s, c)
    { ...s1, server: { ...s1.server, pending: removeKey(s1.server.pending, c) } }
  }

  /// Transport.deleteSession on the server: streams see UNEXPECTED_DISCONNECT,
  /// tombstones go, and the session closes its connection.
  pure def serverDeleteSession(s: State): State = match s.server.session {
    | None => s
    | Some(ss) => {
      val s1 = s.sStreams.keys().fold(s, (acc, sid) => sStreamOnClosing(acc, sid))
      val s2 = { ...s1, server: { ...s1.server, tombstones: Set() } }
      val s3 = match ss.st {
        | SConnected(c) => closeConn(s2, c)
        | SNoConn => s2
      }
      setServer(s3, None)
    }
  }

  /// ConnectedToNoConnection on the server.
  pure def serverConnLost(s: State): State = match s.server.session {
    | Some(ss) => match ss.st {
      | SConnected(c) => {
        val s1 = closeConn(s, c)
        val g = allocTimer(s1, s1.now + s1.cfg.grace)
        setServer(g.s, Some({ ...ss, st: SNoConn, grace: Some(g.t), wd: None, hb: None }))
      }
      | SNoConn => s
    }
    | None => s
  }

  pure def serverReject(s: State, c: int, code: str, cause: str): State = {
    val s1 = push(s, c, false, HsResp({ ok: false, sess: 0, code: code }))
    val s2 = addSErr({ ...s1, obs: { ...s1.obs, rejections: s1.obs.rejections.append(cause) } }, HANDSHAKE_FAILED)
    deletePending(s2, c)
  }

  pure def freshServerSession(sess: int): ServerSession = {
    sess: sess,
    st: SNoConn,
    seq: 0,
    ack: 0,
    seqSent: 0,
    buf: [],
    grace: None,
    wd: None,
    hb: None,
    lastInbound: 0,
  }

  pure def serverAccept(s: State, c: int, sess: int, inherit: bool): State = {
    val s1 = push(s, c, false, HsResp({ ok: true, sess: sess, code: "" }))
    val s2 = { ...s1, server: { ...s1.server, pending: removeKey(s1.server.pending, c) } }
    val w = allocTimer(s2, s2.now + s2.cfg.heartbeat)
    val base = match s2.server.session {
      | Some(old) => if (inherit) old else freshServerSession(sess)
      | None => freshServerSession(sess)
    }
    val ss = { ...base, sess: sess, st: SConnected(c), grace: None, wd: Some(w.t), hb: None, lastInbound: s2.now }
    val s3 = serverSendBuffered(setServer(w.s, Some(ss)))
    val h = allocTimer(s3, s3.now + s3.cfg.heartbeat)
    match h.s.server.session {
      | Some(ss3) => setServer(h.s, Some({ ...ss3, hb: Some(h.t) }))
      | None => h.s
    }
  }

  pure def serverAcceptOrUnknown(s: State, c: int, h: HsReqFrame): State =
    if (h.nextSentSeq > 0 or h.nextExpectedSeq > 0) serverReject(s, c, SESSION_STATE_MISMATCH, "UNKNOWN_SESSION")
    else serverAccept(s, c, h.sess, false)

  /// onHandshakeRequest: new session, unknown session, transparent reconnect,
  /// or hard reconnect.
  pure def serverOnHsReq(s: State, c: int, h: HsReqFrame): State = {
    val p = s.server.pending.get(c)
    if (p.gotHandshake) deletePending(s, c)
    else {
      val s0 = { ...s, server: { ...s.server, pending: s.server.pending.set(c, { ...p, gotHandshake: true }) } }
      match s0.server.session {
        | Some(old) =>
          if (old.sess == h.sess) {
            if (h.nextSentSeq > old.ack) serverReject(s0, c, SESSION_STATE_MISMATCH, "FUTURE_CLIENT")
            else if (nextSeq(old.buf, old.seq) > h.nextExpectedSeq) serverReject(s0, c, SESSION_STATE_MISMATCH, "FUTURE_SERVER")
            else serverAccept(serverConnLost(s0), c, h.sess, true)
          } else serverAcceptOrUnknown(serverDeleteSession(s0), c, h)
        | None => serverAcceptOrUnknown(s0, c, h)
      }
    }
  }

  pure def serverRecvData(s: State, m: Msg): State = match s.server.session {
    | Some(ss) => match ss.st {
      | SConnected(c) =>
        if (m.seq < ss.ack) s
        else if (m.seq > ss.ack) closeConn({ ...s, obs: { ...s.obs, sOoo: s.obs.sOoo + 1 } }, c)
        else {
          val ss1 = { ...ss, buf: ss.buf.select(x => x.seq >= m.ack), ack: m.seq + 1, lastInbound: s.now }
          val o1 = if (m.sess != ss.sess) { ...s.obs, crossSession: true } else s.obs
          val o2 = if (m.ack > ss.seq) { ...o1, ackBeyondSent: true } else o1
          val s1 = setServer({ ...s, obs: o2 }, Some(ss1))
          match m.body {
            // the server heartbeats actively, so it does not echo
            | Heartbeat => s1
            | _ => serverRouterRecv(s1, m.body)
          }
        }
      | SNoConn => s
    }
    | None => s
  }

  //////////////////////////////////////////////////////////////////////////////
  // Frames, close events, garbage
  //////////////////////////////////////////////////////////////////////////////

  pure def serverOnFrame(s: State, c: int, f: Frame): State =
    if (s.server.pending.keys().contains(c)) match f {
      | HsReq(h) => serverOnHsReq(s, c, h)
      | _ => serverReject(s, c, "MALFORMED_HANDSHAKE", "MALFORMED")
    }
    else match s.server.session {
      | Some(ss) =>
        if (ss.st == SConnected(c)) match f {
          | Data(m) => serverRecvData(s, m)
          | _ => s
        } else s
      | None => s
    }

  pure def clientOnFrame(s: State, c: int, f: Frame): State = match s.client.session {
    | Some(cs) => match cs.st {
      | CHandshaking(x) =>
        if (x != c) s
        else match f {
          | HsResp(r) => clientOnHsResp(s, r)
          | _ => clientDeleteSession(s)
        }
      | CConnected(x) =>
        if (x != c) s
        else match f {
          | Data(m) => clientRecvData(s, m)
          | _ => s
        }
      | _ => s
    }
    | None => s
  }

  pure def deliver(s: State, c: int, toServer: bool): State = {
    val cn = s.conns.get(c)
    if (toServer) serverOnFrame({ ...s, conns: s.conns.set(c, { ...cn, toServer: cn.toServer.tail() }) }, c, cn.toServer.head())
    else clientOnFrame({ ...s, conns: s.conns.set(c, { ...cn, toClient: cn.toClient.tail() }) }, c, cn.toClient.head())
  }

  pure def drop(s: State, c: int, toServer: bool): State = {
    val cn = s.conns.get(c)
    if (toServer) { ...s, conns: s.conns.set(c, { ...cn, toServer: cn.toServer.tail() }) }
    else { ...s, conns: s.conns.set(c, { ...cn, toClient: cn.toClient.tail() }) }
  }

  /// A close event reaches one side; frames still headed there are lost.
  pure def closeEvent(s: State, c: int, server: bool): State = {
    val cn = s.conns.get(c)
    if (server) {
      val s1 = { ...s, conns: s.conns.set(c, { ...cn, serverEv: true, toServer: [] }) }
      if (s1.server.pending.keys().contains(c)) deletePending(s1, c)
      else match s1.server.session {
        | Some(ss) => if (ss.st == SConnected(c)) serverConnLost(s1) else s1
        | None => s1
      }
    } else {
      val s1 = { ...s, conns: s.conns.set(c, { ...cn, clientEv: true, toClient: [] }) }
      match s1.client.session {
        | Some(cs) => match cs.st {
          | CHandshaking(x) => if (x == c) clientConnLost(s1) else s1
          | CConnected(x) => if (x == c) clientConnLost(s1) else s1
          | _ => s1
        }
        | None => s1
      }
    }
  }

  /// An undecodable frame. PROTOCOL.md: an invalid handshake or an invalid
  /// message destroys the session (the server drops a pending connection).
  pure def garbage(s: State, c: int, server: bool): State =
    if (server) {
      if (s.server.pending.keys().contains(c)) deletePending(addSErr(s, HANDSHAKE_FAILED), c)
      else match s.server.session {
        | Some(ss) => if (ss.st == SConnected(c)) serverDeleteSession(addSErr(s, INVALID_MESSAGE)) else s
        | None => s
      }
    } else match s.client.session {
      | Some(cs) => match cs.st {
        | CHandshaking(x) => if (x == c) clientDeleteSession(addCErr(s, HANDSHAKE_FAILED)) else s
        | CConnected(x) => if (x == c) clientDeleteSession(addCErr(s, INVALID_MESSAGE)) else s
        | _ => s
      }
      | None => s
    }

  /// A successful dial: the server accepts first, then the client either starts
  /// handshaking or, if it already gave up on this dial, closes the connection.
  pure def dialOk(s: State, d: int): State = {
    val c = s.ids.conn
    val s1 = {
      ...s,
      ids: { ...s.ids, conn: c + 1 },
      dials: s.dials.exclude(Set(d)),
      conns: s.conns.put(c, { toServer: [], toClient: [], closed: false, clientEv: false, serverEv: false }),
    }
    // a closed server transport ignores new connections
    val s2 = if (s1.server.closed) s1 else {
      val h = allocTimer(s1, s1.now + s1.cfg.handshakeTimeout)
      { ...h.s, server: { ...h.s.server, pending: h.s.server.pending.put(c, { hs: h.t, gotHandshake: false }) } }
    }
    match s2.client.session {
      | Some(cs) =>
        if (cs.st == CConnecting(d)) {
          val g = allocTimer(s2, max(s2.now, graceAt(cs.grace, s2.now)))
          val t = allocTimer(g.s, g.s.now + g.s.cfg.handshakeTimeout)
          val s3 = setClient(t.s, Some({ ...cs, st: CHandshaking(c), grace: Some(g.t), stTimer: Some(t.t) }))
          push(s3, c, true, HsReq({ sess: cs.sess, nextExpectedSeq: cs.ack, nextSentSeq: nextSeq(cs.buf, cs.seq) }))
        } else closeConn(s2, c)
      | None => closeConn(s2, c)
    }
  }

  pure def dialFail(s: State, d: int): State = {
    val s1 = { ...s, dials: s.dials.exclude(Set(d)) }
    match s1.client.session {
      | Some(cs) => if (cs.st == CConnecting(d)) clientConnectingFailed(s1) else s1
      | None => s1
    }
  }

  /// The server process dies: its side of every connection is gone, frames in
  /// flight to it are lost, and it forgets all sessions and streams.
  pure def serverRestart(s: State): State = {
    val conns1 = s.conns.keys().mapBy(k => { ...s.conns.get(k), closed: true, serverEv: true, toServer: [] })
    {
      ...s,
      conns: conns1,
      server: { pending: Map(), session: None, tombstones: Set(), epoch: s.server.epoch + 1, closed: false },
      sStreams: Map(),
    }
  }

  /// ServerTransport.close() in a process that keeps running: every session
  /// and every connection still waiting for its handshake goes away.
  pure def serverShutdown(s: State): State = {
    val s1 = serverDeleteSession(s)
    val s2 = s1.server.pending.keys().fold(s1, (acc, c) => deletePending(acc, c))
    { ...s2, server: { ...s2.server, closed: true } }
  }

  //////////////////////////////////////////////////////////////////////////////
  // Timers
  //////////////////////////////////////////////////////////////////////////////

  pure def optTimer(o: Option[Timer], ref: TimerRef): Set[{ ref: TimerRef, t: Timer }] = match o {
    | Some(t) => Set({ ref: ref, t: t })
    | None => Set()
  }

  pure def armed(s: State): Set[{ ref: TimerRef, t: Timer }] = {
    val c = match s.client.session {
      | Some(cs) => optTimer(cs.grace, TClientGrace).union(optTimer(cs.stTimer, TClientState)).union(optTimer(cs.wd, TClientWd))
      | None => Set()
    }
    val p = s.server.pending.keys().map(k => { ref: TPendingHs(k), t: s.server.pending.get(k).hs })
    val v = match s.server.session {
      | Some(ss) => optTimer(ss.grace, TServerGrace).union(optTimer(ss.wd, TServerWd)).union(optTimer(ss.hb, TServerHb))
      | None => Set()
    }
    c.union(p).union(v)
  }

  pure def earlier(a: Timer, b: Timer): bool = a.at < b.at or (a.at == b.at and a.id < b.id)

  pure def nextTimer(s: State): Option[{ ref: TimerRef, t: Timer }] =
    armed(s).fold(None, (acc, x) => match acc {
      | None => Some(x)
      | Some(y) => if (earlier(x.t, y.t)) Some(x) else acc
    })

  /// Pending timers in the implementation, including the retry budget's restore interval.
  pure def timerCount(s: State): int =
    armed(s).size() + (if (s.client.restoreActive) 1 else 0)

  /// The heartbeat watchdog: an interval that closes the connection once the
  /// peer has been silent for heartbeatsUntilDead heartbeats.
  pure def watchdogDead(s: State, lastInbound: int): bool =
    s.now - lastInbound >= s.cfg.heartbeat * s.cfg.heartbeatsUntilDead

  pure def fire(s0: State, ref: TimerRef, t: Timer): State = {
    val after = fireIn({ ...s0, now: t.at, inTimer: true }, ref, t)
    { ...after, inTimer: false }
  }

  pure def fireIn(s: State, ref: TimerRef, t: Timer): State = {
    match ref {
      | TClientGrace => clientDeleteSession(s)
      | TClientState => match s.client.session {
        | Some(cs) => match cs.st {
          | CBackingOff => clientBackoffDone(s)
          | CConnecting(_) => clientConnectingFailed(s)
          | CHandshaking(_) => clientConnLost(s)
          | _ => s
        }
        | None => s
      }
      | TClientWd => match s.client.session {
        | Some(cs) => match cs.st {
          | CConnected(c) => {
            val r = rearmInterval(s, t)
            if (watchdogDead(r.s, cs.lastInbound)) closeConn(setClient(r.s, Some({ ...cs, wd: None })), c)
            else setClient(r.s, Some({ ...cs, wd: Some(r.t) }))
          }
          | _ => s
        }
        | None => s
      }
      | TPendingHs(c) => deletePending(s, c)
      | TServerGrace => serverDeleteSession(s)
      | TServerWd => match s.server.session {
        | Some(ss) => match ss.st {
          | SConnected(c) => {
            val r = rearmInterval(s, t)
            if (watchdogDead(r.s, ss.lastInbound)) closeConn(setServer(r.s, Some({ ...ss, wd: None })), c)
            else setServer(r.s, Some({ ...ss, wd: Some(r.t) }))
          }
          | SNoConn => s
        }
        | None => s
      }
      | TServerHb => match s.server.session {
        | Some(ss) => {
          val r = rearmInterval(s, t)
          serverSend(setServer(r.s, Some({ ...ss, hb: Some(r.t) })), Heartbeat)
        }
        | None => s
      }
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  // Application operations
  //////////////////////////////////////////////////////////////////////////////

  /// createClient proxy with connectOnInvoke, then handleProc.
  pure def clientInvoke(s: State, pt: ProcType): State = {
    val s1 = match s.client.session {
      | Some(_) => s
      | None => clientConnect(s)
    }
    match s1.client.session {
      | Some(cs) => {
        val sid = s1.ids.stream
        val cwi = closesWithInit(pt)
        val c = {
          pt: pt,
          sess: cs.sess,
          w: true,
          r: true,
          clean: true,
          listening: true,
          aborted: false,
          results: [],
          written: [],
          gotCancel: false,
          sentClose: cwi,
        }
        val s2 = { ...s1, ids: { ...s1.ids, stream: sid + 1 }, cStreams: s1.cStreams.put(sid, c) }
        val s3 = clientSend(s2, SInit({ sid: sid, pt: pt, close: cwi }))
        if (cwi) setCStream(s3, sid, { ...s3.cStreams.get(sid), w: false }) else s3
      }
      | None => s1
    }
  }

  pure def clientWrite(s: State, sid: int): State = {
    val c = s.cStreams.get(sid)
    val v = c.written.length() + 1
    clientStreamSend(setCStream(s, sid, { ...c, written: c.written.append(v) }), sid, SData({ sid: sid, v: v }), false)
  }

  pure def clientClose(s: State, sid: int): State = {
    val c = s.cStreams.get(sid)
    val c1 = { ...c, w: false }
    val s1 = setCStream(s, sid, c1)
    val s2 = if (c.clean) clientStreamSend(s1, sid, SClose(sid), true) else s1
    val c2 = s2.cStreams.get(sid)
    if (not(c2.r)) setCStream(s2, sid, { ...c2, listening: false }) else s2
  }

  /// onClientCancel via the call's AbortSignal.
  pure def clientCancel(s: State, sid: int): State = {
    val c = s.cStreams.get(sid)
    val res = if (c.r) c.results.append(RErr("CANCEL")) else c.results
    val c1 = { ...c, aborted: true, clean: false, r: false, w: false, listening: false, results: res }
    clientStreamSend(setCStream(s, sid, c1), sid, SCancel({ sid: sid, code: "CANCEL" }), false)
  }

  /// rpc/upload handler resolves with Ok(v): the result closes the response.
  pure def serverRespond(s: State, sid: int): State = {
    val x = { ...s.sStreams.get(sid), handlerDone: true }
    if (not(x.w)) setSStream(s, sid, x)
    else {
      val v = 100 + x.written.length() + 1
      val s1 = setSStream(s, sid, { ...x, written: x.written.append(v) })
      serverCloseWritable(serverStreamSend(s1, sid, SResult({ sid: sid, v: v, close: true }), true), sid)
    }
  }

  pure def serverWrite(s: State, sid: int): State = {
    val x = s.sStreams.get(sid)
    val v = 100 + x.written.length() + 1
    serverStreamSend(setSStream(s, sid, { ...x, written: x.written.append(v) }), sid, SResult({ sid: sid, v: v, close: false }), false)
  }

  pure def serverThrow(s: State, sid: int): State =
    serverOnCancel(setSStream(s, sid, { ...s.sStreams.get(sid), handlerDone: true }), sid, "UNCAUGHT_ERROR")

  //////////////////////////////////////////////////////////////////////////////
  // State machine
  //////////////////////////////////////////////////////////////////////////////

  var st: State
  var lastAction: Action

  /// A linear congruential generator that only `step` reads, to make faults
  /// rare. The simulator retries nondeterministic picks until an action is
  /// enabled, so a guard on a random pick cannot lower an action's frequency;
  /// a guard on state it cannot choose can. `stepAll` ignores it.
  var rng: int

  pure def nextRng(r: int): int = (r * 1103515245 + 12345) % 2147483648

  /// True on roughly one step in `n`, from the generator's high bits.
  pure def oneIn(r: int, n: int): bool = (r / 65536) % n == 0

  pure val initState: State = {
    cfg: CFG,
    now: 0,
    inTimer: false,
    ids: { sess: 1, conn: 1, dial: 1, stream: 1, timer: 1 },
    client: { session: None, attempts: 0, restoreActive: false },
    server: { pending: Map(), session: None, tombstones: Set(), epoch: 0, closed: false },
    conns: Map(),
    dials: Set(),
    cStreams: Map(),
    sStreams: Map(),
    obs: {
      cErrs: [],
      sErrs: [],
      cOoo: 0,
      sOoo: 0,
      rejections: [],
      crossSession: false,
      ackBeyondSent: false,
      sendOrder: false,
      sentAfterCancel: false,
      sentAfterClose: false,
    },
  }

  action init = {
    // each trace gets its own fault schedule
    nondet seed = oneOf(1.to(1000000))
    all {
      st' = initState,
      lastAction' = AInit,
      rng' = seed,
    }
  }

  action invokeAs(pt: ProcType): bool = all {
    st.ids.stream <= st.cfg.maxStreams,
    st' = clientInvoke(st, pt),
    lastAction' = AInvoke({ sid: st.ids.stream, pt: pt }),
    rng' = nextRng(rng),
  }

  action writeOn(sid: int): bool = all {
    st.cStreams.keys().contains(sid),
    val c = st.cStreams.get(sid)
    all {
      acceptsRequests(c.pt),
      c.w,
      c.written.length() < st.cfg.maxWrites,
      st' = clientWrite(st, sid),
      lastAction' = AWrite({ sid: sid, v: c.written.length() + 1 }),
      rng' = nextRng(rng),
    },
  }

  action closeOn(sid: int): bool = all {
    st.cStreams.keys().contains(sid),
    acceptsRequests(st.cStreams.get(sid).pt),
    st.cStreams.get(sid).w,
    st' = clientClose(st, sid),
    lastAction' = AClose(sid),
    rng' = nextRng(rng),
  }

  action cancelOn(sid: int): bool = all {
    st.cStreams.keys().contains(sid),
    st.cStreams.get(sid).listening,
    not(st.cStreams.get(sid).aborted),
    st' = clientCancel(st, sid),
    lastAction' = ACancel(sid),
    rng' = nextRng(rng),
  }

  action respondOn(sid: int): bool = all {
    st.sStreams.keys().contains(sid),
    closesWithResponse(st.sStreams.get(sid).pt),
    not(st.sStreams.get(sid).handlerDone),
    st' = serverRespond(st, sid),
    lastAction' = ARespond({ sid: sid, v: 100 + st.sStreams.get(sid).written.length() + 1 }),
    rng' = nextRng(rng),
  }

  action serverWriteOn(sid: int): bool = all {
    st.sStreams.keys().contains(sid),
    val x = st.sStreams.get(sid)
    all {
      not(closesWithResponse(x.pt)),
      x.w,
      x.written.length() < st.cfg.maxWrites,
      st' = serverWrite(st, sid),
      lastAction' = ASWrite({ sid: sid, v: 100 + x.written.length() + 1 }),
      rng' = nextRng(rng),
    },
  }

  action serverCloseOn(sid: int): bool = all {
    st.sStreams.keys().contains(sid),
    not(closesWithResponse(st.sStreams.get(sid).pt)),
    st.sStreams.get(sid).w,
    st' = serverCloseWritable(st, sid),
    lastAction' = ASClose(sid),
    rng' = nextRng(rng),
  }

  action serverCancelOn(sid: int): bool = all {
    st.sStreams.keys().contains(sid),
    st.sStreams.get(sid).r or st.sStreams.get(sid).w,
    st' = serverOnCancel(st, sid, "CANCEL"),
    lastAction' = ASCancel(sid),
    rng' = nextRng(rng),
  }

  action throwOn(sid: int): bool = all {
    st.sStreams.keys().contains(sid),
    not(st.sStreams.get(sid).handlerDone),
    st' = serverThrow(st, sid),
    lastAction' = AThrow(sid),
    rng' = nextRng(rng),
  }

  action deliverOn(c: int, toServer: bool): bool = all {
    st.conns.keys().contains(c),
    val cn = st.conns.get(c)
    if (toServer) all { cn.toServer.length() > 0, not(cn.serverEv) }
    else all { cn.toClient.length() > 0, not(cn.clientEv) },
    st' = deliver(st, c, toServer),
    lastAction' = ADeliver({ conn: c, toServer: toServer }),
    rng' = nextRng(rng),
  }

  action dropOn(c: int, toServer: bool): bool = all {
    st.conns.keys().contains(c),
    val cn = st.conns.get(c)
    if (toServer) cn.toServer.length() > 0 else cn.toClient.length() > 0,
    st' = drop(st, c, toServer),
    lastAction' = ADrop({ conn: c, toServer: toServer }),
    rng' = nextRng(rng),
  }

  action breakOn(c: int): bool = all {
    st.conns.keys().contains(c),
    not(st.conns.get(c).closed),
    st' = closeConn(st, c),
    lastAction' = ABreak(c),
    rng' = nextRng(rng),
  }

  action closeEventOn(c: int, server: bool): bool = all {
    st.conns.keys().contains(c),
    val cn = st.conns.get(c)
    all { cn.closed, if (server) not(cn.serverEv) else not(cn.clientEv) },
    st' = closeEvent(st, c, server),
    lastAction' = ACloseEvent({ conn: c, server: server }),
    rng' = nextRng(rng),
  }

  action garbageOn(c: int, server: bool): bool = all {
    st.conns.keys().contains(c),
    val cn = st.conns.get(c)
    if (server) not(cn.serverEv) else not(cn.clientEv),
    st' = garbage(st, c, server),
    lastAction' = AGarbage({ conn: c, server: server }),
    rng' = nextRng(rng),
  }

  action dialOkOn(d: int): bool = all {
    st.dials.contains(d),
    st' = dialOk(st, d),
    lastAction' = ADialOk(d),
    rng' = nextRng(rng),
  }

  action dialFailOn(d: int): bool = all {
    st.dials.contains(d),
    st' = dialFail(st, d),
    lastAction' = ADialFail(d),
    rng' = nextRng(rng),
  }

  action tickBy(dt: int): bool = all {
    dt > 0,
    match nextTimer(st) {
      | Some(x) => st.now + dt < x.t.at
      | None => true
    },
    st' = { ...st, now: st.now + dt },
    lastAction' = ATick(dt),
    rng' = nextRng(rng),
  }

  action fireTimer = all {
    armed(st) != Set(),
    match nextTimer(st) {
      | Some(x) => all { st' = fire(st, x.ref, x.t), lastAction' = AFire(x.ref), rng' = nextRng(rng) }
      | None => all { st' = st, lastAction' = lastAction, rng' = rng }
    },
  }

  action restart = all {
    st' = serverRestart(st),
    lastAction' = ARestart,
    rng' = nextRng(rng),
  }

  action hardDisconnect = all {
    st' = clientDeleteSession(st),
    lastAction' = AHardDisconnect,
    rng' = nextRng(rng),
  }

  action serverClose = all {
    not(st.server.closed),
    st' = serverShutdown(st),
    lastAction' = AServerClose,
    rng' = nextRng(rng),
  }

  /// Streams where the application on either side can still act.
  pure def activeStreams(s: State): Set[int] = s.cStreams.keys().filter(sid => {
    val c = s.cStreams.get(sid)
    val clientCan = c.listening
    val serverCan = s.sStreams.keys().contains(sid) and {
      val x = s.sStreams.get(sid)
      x.r or x.w or not(x.handlerDone)
    }
    clientCan or serverCan
  })

  pure def deliverable(s: State): Set[{ conn: int, toServer: bool }] =
    s.conns.keys().fold(Set(), (acc, k) => {
      val cn = s.conns.get(k)
      val a1 = if (cn.toServer.length() > 0 and not(cn.serverEv)) acc.union(Set({ conn: k, toServer: true })) else acc
      if (cn.toClient.length() > 0 and not(cn.clientEv)) a1.union(Set({ conn: k, toServer: false })) else a1
    })

  pure def closeEventsDue(s: State): Set[{ conn: int, server: bool }] =
    s.conns.keys().fold(Set(), (acc, k) => {
      val cn = s.conns.get(k)
      val a1 = if (cn.closed and not(cn.serverEv)) acc.union(Set({ conn: k, server: true })) else acc
      if (cn.closed and not(cn.clientEv)) a1.union(Set({ conn: k, server: false })) else a1
    })

  pure def openConns(s: State): Set[int] = s.conns.keys().filter(k => not(s.conns.get(k).closed))

  action onStream = all {
    activeStreams(st) != Set(),
    nondet sid = oneOf(activeStreams(st))
    any {
      writeOn(sid),
      closeOn(sid),
      cancelOn(sid),
      respondOn(sid),
      serverWriteOn(sid),
      serverCloseOn(sid),
      serverCancelOn(sid),
      throwOn(sid),
    },
  }

  action deliverAny = all {
    deliverable(st) != Set(),
    nondet x = oneOf(deliverable(st))
    deliverOn(x.conn, x.toServer),
  }

  action closeEventAny = all {
    closeEventsDue(st) != Set(),
    nondet x = oneOf(closeEventsDue(st))
    closeEventOn(x.conn, x.server),
  }

  action onDial = all {
    st.dials != Set(),
    nondet d = oneOf(st.dials)
    dialOkOn(d),
  }

  action networkFault = any {
    all {
      deliverable(st) != Set(),
      nondet x = oneOf(deliverable(st))
      any { dropOn(x.conn, x.toServer), garbageOn(x.conn, x.toServer) },
    },
    all {
      openConns(st) != Set(),
      nondet c = oneOf(openConns(st))
      nondet toServer = oneOf(Set(true, false))
      any { breakOn(c), garbageOn(c, toServer) },
    },
  }

  action dialFailAny = all {
    st.dials != Set(),
    nondet d = oneOf(st.dials)
    dialFailOn(d),
  }

  action progress = any {
    nondet pt = oneOf(Set(PRpc, PStream, PUpload, PSubscription))
    invokeAs(pt),
    onStream,
    onStream,
    deliverAny,
    deliverAny,
    deliverAny,
    closeEventAny,
    onDial,
    nondet dt = oneOf(TICKS)
    tickBy(dt),
    fireTimer,
  }

  /// The network is usually fast relative to heartbeats: on most steps where a
  /// frame is in flight, the next thing that happens is its delivery.
  pure def deliverPromptly(s: State, r: int): bool =
    deliverable(s) != Set() and not(oneIn(r, 3))

  /// Faults are rare relative to progress, and process-level faults rarer still,
  /// so traces get far enough to exercise reconnects rather than only teardown.
  action step = {
    val r2 = nextRng(rng)
    val r3 = nextRng(r2)
    any {
      all { deliverPromptly(st, rng), deliverAny },
      all {
        not(deliverPromptly(st, rng)),
        any {
          progress,
          all { oneIn(r2, 2), networkFault },
          all { oneIn(r2, 4), dialFailAny },
          all { oneIn(r3, 80), restart },
          all { oneIn(nextRng(r3), 80), hardDisconnect },
          all { oneIn(nextRng(nextRng(r3)), 200), serverClose },
        },
      },
    }
  }

  /// Every behavior, unweighted: the step relation for exhaustive checking.
  action stepAll = any {
    progress,
    networkFault,
    dialFailAny,
    restart,
    hardDisconnect,
    serverClose,
  }

  //////////////////////////////////////////////////////////////////////////////
  // Invariants (claims PROTOCOL.md makes)
  //////////////////////////////////////////////////////////////////////////////

  /// "Exactly once delivery": every stream sees a prefix of what its peer
  /// wrote, in order, with nothing duplicated.
  val exactlyOnceInOrder = st.sStreams.keys().forall(sid =>
    st.cStreams.keys().contains(sid) implies all {
      isPrefix(oks(st.sStreams.get(sid).values), st.cStreams.get(sid).written),
      isPrefix(oks(st.cStreams.get(sid).results), st.sStreams.get(sid).written),
    }
  )

  /// A session never processes a message sent by a different session.
  val noCrossSession = not(st.obs.crossSession)

  /// An ack never covers messages the receiver has not sent.
  val noAckBeyondSent = not(st.obs.ackBeyondSent)

  /// assertSendOrdering never trips.
  val sendOrdering = not(st.obs.sendOrder)

  pure def sameSession(s: State): bool = match s.client.session {
    | Some(cs) => match s.server.session {
      | Some(ss) => cs.sess == ss.sess
      | None => false
    }
    | None => false
  }

  /// Unacknowledged messages are never dropped from the send buffer.
  val bufferHoldsUnacked = sameSession(st) implies match st.client.session {
    | Some(cs) => match st.server.session {
      | Some(ss) => bufCovers(cs.buf, ss.ack, cs.seq) and bufCovers(ss.buf, cs.ack, ss.seq)
      | None => true
    }
    | None => true
  }

  /// Neither side has acknowledged more than its peer sent.
  val acksBounded = sameSession(st) implies match st.client.session {
    | Some(cs) => match st.server.session {
      | Some(ss) => cs.ack <= ss.seq and ss.ack <= cs.seq
      | None => true
    }
    | None => true
  }

  /// SESSION_STATE_MISMATCH for a session the server still holds only happens
  /// when state was actually lost, which correct peers never cause.
  val noNeedlessRejection = st.obs.rejections.foldl(true, (ok, r) => ok and r != "FUTURE_CLIENT" and r != "FUTURE_SERVER")

  /// A disconnected session is always on its way to teardown.
  val graceWhileDisconnected = all {
    match st.client.session {
      | Some(cs) => match cs.st {
        | CConnected(_) => not(isSomeTimer(cs.grace))
        | _ => isSomeTimer(cs.grace)
      }
      | None => true
    },
    match st.server.session {
      | Some(ss) => match ss.st {
        | SConnected(_) => not(isSomeTimer(ss.grace))
        | SNoConn => isSomeTimer(ss.grace)
      }
      | None => true
    },
  }

  /// A live connection is always watched for phantom disconnects.
  val watchdogWhileConnected = all {
    match st.client.session {
      | Some(cs) => match cs.st {
        | CConnected(c) => st.conns.get(c).closed or isSomeTimer(cs.wd)
        | _ => true
      }
      | None => true
    },
    match st.server.session {
      | Some(ss) => match ss.st {
        | SConnected(c) => st.conns.get(c).closed or isSomeTimer(ss.wd)
        | SNoConn => true
      }
      | None => true
    },
  }

  pure def cStreamResolved(s: State, sid: int): bool = {
    val c = s.cStreams.get(sid)
    val live = match s.client.session {
      | Some(cs) => cs.sess == c.sess
      | None => false
    }
    live or (not(c.r) and not(c.w) and not(c.listening))
  }

  pure def sStreamResolved(s: State, sid: int): bool = {
    val x = s.sStreams.get(sid)
    val live = match s.server.session {
      | Some(ss) => ss.sess == x.sess
      | None => false
    }
    live or (not(x.r) and not(x.w) and not(x.inMap))
  }

  /// When a session dies, every stream it carried is resolved on both sides.
  val teardownResolvesStreams = all {
    st.cStreams.keys().forall(sid => cStreamResolved(st, sid)),
    st.sStreams.keys().forall(sid => sStreamResolved(st, sid)),
  }

  /// "A full-close is ... when a cancellation happens which results in an
  /// immediate full-close": nothing is sent on a stream after its cancel arrives.
  val cancelIsFinal = not(st.obs.sentAfterCancel)

  /// "The closing party MUST NOT send any more messages" (cancel excepted).
  val closeIsFinal = not(st.obs.sentAfterClose)

  //////////////////////////////////////////////////////////////////////////////
  // Witnesses: `quint run --witnesses` counts the traces that reach each one,
  // which shows whether simulation actually exercises the interesting paths.
  //////////////////////////////////////////////////////////////////////////////

  val wConnected = match st.client.session {
    | Some(cs) => match cs.st {
      | CConnected(_) => true
      | _ => false
    }
    | None => false
  }

  /// Still on the first session, but over a later connection.
  val wTransparentReconnect = match st.client.session {
    | Some(cs) => match cs.st {
      | CConnected(c) => cs.sess == 1 and c > 1
      | _ => false
    }
    | None => false
  }

  val wNewSessionAfterLoss = match st.client.session {
    | Some(cs) => match cs.st {
      | CConnected(_) => cs.sess > 1
      | _ => false
    }
    | None => false
  }

  val wOutOfOrder = st.obs.cOoo + st.obs.sOoo > 0

  val wRejected = st.obs.rejections.length() > 0

  val wDisconnectResolved = st.cStreams.keys().exists(sid => st.cStreams.get(sid).results.foldl(false, (acc, r) => acc or r == RErr("UNEXPECTED_DISCONNECT")))

  val wStreamCompleted = st.cStreams.keys().exists(sid => {
    val c = st.cStreams.get(sid)
    not(c.r) and oks(c.results).length() > 0
  })

  val wCancelled = st.cStreams.keys().exists(sid => st.cStreams.get(sid).gotCancel)

  val wServerRestarted = st.server.epoch > 0

  /// A closed server transport holds no sessions and no pending handshakes.
  val closedServerIsEmpty = st.server.closed implies all {
    st.server.session == None,
    st.server.pending.keys() == Set(),
  }

  val wServerClosed = st.server.closed

  val safety = all {
    closedServerIsEmpty,
    exactlyOnceInOrder,
    noCrossSession,
    noAckBeyondSent,
    sendOrdering,
    bufferHoldsUnacked,
    acksBounded,
    noNeedlessRejection,
    graceWhileDisconnected,
    watchdogWhileConnected,
    teardownResolvesStreams,
    closeIsFinal,
  }
}
