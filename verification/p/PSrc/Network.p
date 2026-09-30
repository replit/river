/*****************************************************************************
WsConnection: one machine per WebSocket connection instance.

P guarantees FIFO delivery per sender->receiver machine pair, so routing all
traffic through this machine gives WebSocket's ordered reliable delivery
within a connection for free, while messages traveling through DIFFERENT
connection instances race naturally — exactly the "old socket's buffered
frames arrive after the new handshake" interleaving the d7c0ec9 bug lived in.

Faults: eFaultDrop kills the connection and notifies both sides, one side, or
neither (phantom disconnect), per tDropMode. eConnCloseCmd is an
endpoint-initiated close (TS conn.close()): both sides get the close event.
Once Closed, all in-transit sends die on the wire.
*****************************************************************************/

machine WsConnection {
  var client: machine;
  var server: machine;
  var connId: int;
  var dropDefers: int;
  var clientUnnotified: bool;
  var serverUnnotified: bool;

  start state Open {
    entry (cfg: tConnCfg) {
      client = cfg.client;
      server = cfg.server;
      connId = cfg.connId;
      dropDefers = 4;
      send client, eConnEstablished, (connId = connId, conn = this);
    }
    on eSendMsg do (s: (toServer: bool, msg: tMsg)) {
      if (s.toServer) {
        send server, eDeliverMsg, (connId = connId, msg = s.msg);
      } else {
        send client, eDeliverMsg, (connId = connId, msg = s.msg);
      }
    }
    on eSendHsReq do (h: tHsReq) { send server, eDeliverHsReq, h; }
    on eSendHsResp do (h: tHsResp) { send client, eDeliverHsResp, h; }
    // The fault injector decides to drop a connection when it is created; the
    // budgeted nondeterministic defers below move the actual drop point to an
    // arbitrary later position in the connection's message stream (the same
    // shape as the hegel write-schedule generator's `null` fault points).
    on eFaultDrop do (mode: tDropMode) {
      if (dropDefers > 0 && $) {
        dropDefers = dropDefers - 1;
        send this, eFaultDrop, mode;
      } else {
        if (mode == DROP_BOTH || mode == DROP_CLIENT_ONLY) {
          send client, eConnClosed, connId;
        } else {
          clientUnnotified = true;
        }
        if (mode == DROP_BOTH || mode == DROP_SERVER_ONLY) {
          send server, eConnClosed, connId;
        } else {
          serverUnnotified = true;
        }
        if (clientUnnotified || serverUnnotified) {
          // the unnotified side's heartbeat watchdog eventually notices
          send this, eWatchdogDetect, 3;
        }
        goto Closed;
      }
    }
    on eConnCloseCmd do {
      send client, eConnClosed, connId;
      send server, eConnClosed, connId;
      goto Closed;
    }
  }

  state Closed {
    on eWatchdogDetect do (defers: int) {
      if (defers > 0 && $) {
        send this, eWatchdogDetect, defers - 1;
      } else {
        if (clientUnnotified) {
          send client, eConnClosed, connId;
          clientUnnotified = false;
        }
        if (serverUnnotified) {
          send server, eConnClosed, connId;
          serverUnnotified = false;
        }
      }
    }
    ignore eSendMsg, eSendHsReq, eSendHsResp, eFaultDrop, eConnCloseCmd;
  }
}
