// -*- mode: Bluespec; -*-

/// Scenarios for spec/river.qnt. Each `run` drives the model through one
/// behavior PROTOCOL.md describes and checks the outcome. `quint test` runs
/// them, and the conformance suite replays every one of them against the
/// TypeScript implementation.
module river_test {
  import river.* from "./river"

  pure def clientIs(s: State, sess: int, cst: CState): bool = match s.client.session {
    | Some(cs) => cs.sess == sess and cs.st == cst
    | None => false
  }

  /// Invoke, connect, and get the first stream's init to the server.
  action connectWith(pt: ProcType): bool =
    invokeAs(pt)
      // the first connection attempt has no backoff
      .then(fireTimer)
      .then(dialOkOn(1))
      // handshake request, then response; the buffered init goes out
      .then(deliverOn(1, true))
      .then(deliverOn(1, false))
      // the init opens the stream on the server
      .then(deliverOn(1, true))

  /// rpc: one request, one response that closes the call.
  run rpcRoundTripTest =
    init
      .then(connectWith(PRpc))
      .then(respondOn(1))
      .then(deliverOn(1, false))
      .expect(all {
        st.cStreams.get(1).results == [ROk(101)],
        not(st.cStreams.get(1).r),
        not(st.sStreams.get(1).inMap),
      })

  /// "Transparent reconnects": a lost frame makes the server see a gap, it
  /// closes the connection, and the reconnect retransmits the send buffer, so
  /// the stream still sees every value exactly once and in order.
  run transparentReconnectAfterFrameLossTest =
    init
      .then(connectWith(PStream))
      .then(writeOn(1))
      .then(writeOn(1))
      // the first value is lost; the second arrives early
      .then(dropOn(1, true))
      .then(deliverOn(1, true))
      .then(closeEventOn(1, true))
      .then(closeEventOn(1, false))
      // back off, then redial
      .then(fireTimer)
      .then(dialOkOn(2))
      // the server still holds the session, so the reconnect is transparent
      .then(deliverOn(2, true))
      .then(deliverOn(2, false))
      // the retransmitted init is a duplicate; both values follow
      .then(deliverOn(2, true))
      .then(deliverOn(2, true))
      .then(deliverOn(2, true))
      .expect(all {
        st.sStreams.get(1).values == [ROk(1), ROk(2)],
        st.obs.sOoo == 1,
        clientIs(st, 1, CConnected(2)),
      })

  /// "Hard reconnect": the server restarts after acknowledging the client, so
  /// it rejects the old session; the in-flight call resolves with
  /// UNEXPECTED_DISCONNECT and the client starts a fresh session.
  run hardReconnectAfterServerRestartTest =
    init
      .then(connectWith(PRpc))
      // server watchdog, then a heartbeat that acknowledges the init
      .then(fireTimer)
      .then(fireTimer)
      .then(deliverOn(1, false))
      .then(restart)
      .then(closeEventOn(1, false))
      .then(fireTimer)
      .then(dialOkOn(2))
      .then(deliverOn(2, true))
      .then(deliverOn(2, false))
      .expect(all {
        st.cStreams.get(1).results == [RErr("UNEXPECTED_DISCONNECT")],
        st.obs.rejections == ["UNKNOWN_SESSION"],
        st.obs.cErrs == [],
        clientIs(st, 2, CBackingOff),
      })

  /// Exactly-once holds per server process: if the server restarts before the
  /// client hears anything from it, the new server cannot tell the reconnect
  /// from a new session, accepts it, and runs the replayed call a second time.
  run serverRestartBeforeFirstReplyReplaysTest =
    init
      .then(connectWith(PRpc))
      .then(restart)
      .then(closeEventOn(1, false))
      .then(fireTimer)
      .then(dialOkOn(2))
      .then(deliverOn(2, true))
      .then(deliverOn(2, false))
      .then(deliverOn(2, true))
      .expect(all {
        st.sStreams.get(1).inMap,
        st.obs.rejections == [],
        clientIs(st, 1, CConnected(2)),
      })

  /// The grace period bounds how long a disconnected session lingers: when
  /// reconnecting keeps failing, both sides tear the session down and resolve
  /// the stream with UNEXPECTED_DISCONNECT.
  run graceExpiryResolvesStreamsTest =
    init
      .then(connectWith(PStream))
      .then(breakOn(1))
      .then(closeEventOn(1, false))
      .then(closeEventOn(1, true))
      // backoff, connection timeout, backoff, timeout, backoff, then both graces
      .then(7.reps(_ => fireTimer))
      .expect(all {
        st.client.session == None,
        st.server.session == None,
        st.cStreams.get(1).results == [RErr("UNEXPECTED_DISCONNECT")],
        st.sStreams.get(1).values == [RErr("UNEXPECTED_DISCONNECT")],
        not(st.sStreams.get(1).w),
        not(st.sStreams.get(1).inMap),
      })

  /// An upload can be finalized after it was cancelled: the result is the
  /// cancellation.
  run uploadFinalizedAfterCancelTest =
    init
      .then(connectWith(PUpload))
      .then(cancelOn(1))
      .then(finalizeOn(1))
      .expect(all {
        st.cStreams.get(1).finalized,
        st.cStreams.get(1).results == [RErr("CANCEL")],
      })

  /// An upload can be finalized after its session ended: the result is
  /// UNEXPECTED_DISCONNECT.
  run uploadFinalizedAfterDisconnectTest =
    init
      .then(connectWith(PUpload))
      .then(breakOn(1))
      .then(closeEventOn(1, false))
      .then(closeEventOn(1, true))
      .then(7.reps(_ => fireTimer))
      .then(finalizeOn(1))
      .expect(all {
        st.client.session == None,
        st.cStreams.get(1).finalized,
        st.cStreams.get(1).results == [RErr("UNEXPECTED_DISCONNECT")],
      })

  /// "Detecting phantom disconnects": when nothing arrives for
  /// heartbeatsUntilDead heartbeat intervals, the watchdog closes the connection.
  run watchdogClosesSilentConnectionTest =
    init
      .then(connectWith(PStream))
      // heartbeats go out but nothing is delivered from here on
      .then(4.reps(_ => fireTimer))
      .expect(all {
        st.conns.get(1).closed,
        st.now == st.cfg.heartbeat * st.cfg.heartbeatsUntilDead,
      })

  /// Known deviation: a cancellation is an immediate full close, yet the
  /// server answers a client's cancel of a subscription with a ControlClose.
  run serverClosesAfterClientCancelTest =
    init
      .then(connectWith(PSubscription))
      .then(cancelOn(1))
      .then(deliverOn(1, true))
      .expect(all {
        st.obs.sentAfterCancel,
        st.conns.get(1).toClient.length() == 1,
      })

  /// An undecodable handshake response destroys the session
  /// ("Handshaking -> x"). The implementation used to throw here instead.
  run invalidHandshakeResponseTest =
    init
      .then(invokeAs(PRpc))
      .then(fireTimer)
      .then(dialOkOn(1))
      .then(garbageOn(1, false))
      .expect(all {
        st.client.session == None,
        st.obs.cErrs == [HANDSHAKE_FAILED],
        st.cStreams.get(1).results == [RErr("UNEXPECTED_DISCONNECT")],
      })

  /// A closed server transport does not complete a handshake that was still in
  /// flight when it closed. The implementation used to create a session here.
  run serverCloseDuringHandshakeTest =
    init
      .then(invokeAs(PRpc))
      .then(fireTimer)
      .then(dialOkOn(1))
      .then(serverClose)
      .then(deliverOn(1, true))
      .expect(all {
        st.server.session == None,
        st.server.pending.keys() == Set(),
        st.conns.get(1).closed,
      })
}
