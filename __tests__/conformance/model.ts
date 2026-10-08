import type {
  Body,
  ClientStreamView,
  ConnView,
  Frame,
  Msg,
  ProcTag,
  Projection,
  Res,
  ServerStreamView,
  SessionView,
} from './projection';

/**
 * Types of spec/river.qnt state after ITF decoding: integers become numbers,
 * sets become arrays, maps become Maps, and sum types become `{ tag, value }`.
 */

export interface Variant<T extends string, V = Unit> {
  tag: T;
  value: V;
}

type Unit = Array<never>;

export type QOption<T> = Variant<'Some', T> | Variant<'None'>;

export interface QTimer {
  at: number;
  id: number;
}

export type QProcType = Variant<ProcTag>;

export type QRes = Variant<'ROk', number> | Variant<'RErr', string>;

export type QBody =
  | Variant<'Heartbeat'>
  | Variant<'SInit', { sid: number; pt: QProcType; close: boolean }>
  | Variant<'SData', { sid: number; v: number }>
  | Variant<'SResult', { sid: number; v: number; close: boolean }>
  | Variant<'SClose', number>
  | Variant<'SCancel', { sid: number; code: string }>;

export interface QMsg {
  seq: number;
  ack: number;
  body: QBody;
  sess: number;
}

export type QFrame =
  | Variant<
      'HsReq',
      { sess: number; nextExpectedSeq: number; nextSentSeq: number }
    >
  | Variant<'HsResp', { ok: boolean; sess: number; code: string }>
  | Variant<'Data', QMsg>;

export interface QConn {
  toServer: Array<QFrame>;
  toClient: Array<QFrame>;
  closed: boolean;
  clientEv: boolean;
  serverEv: boolean;
}

export type QCState =
  | Variant<'CNoConn'>
  | Variant<'CBackingOff'>
  | Variant<'CConnecting', number>
  | Variant<'CHandshaking', number>
  | Variant<'CConnected', number>;

export type QSState = Variant<'SNoConn'> | Variant<'SConnected', number>;

interface QSessionCommon {
  sess: number;
  seq: number;
  ack: number;
  seqSent: number;
  buf: Array<QMsg>;
  grace: QOption<QTimer>;
  wd: QOption<QTimer>;
  lastInbound: number;
}

export interface QClientSession extends QSessionCommon {
  st: QCState;
  stTimer: QOption<QTimer>;
}

export interface QServerSession extends QSessionCommon {
  st: QSState;
  hb: QOption<QTimer>;
}

export interface QCStream {
  pt: QProcType;
  sess: number;
  w: boolean;
  r: boolean;
  clean: boolean;
  listening: boolean;
  aborted: boolean;
  results: Array<QRes>;
  written: Array<number>;
  gotCancel: boolean;
  finalized: boolean;
  sentClose: boolean;
}

export interface QSStream {
  pt: QProcType;
  sess: number;
  r: boolean;
  w: boolean;
  clean: boolean;
  inMap: boolean;
  handlerDone: boolean;
  runs: number;
  values: Array<QRes>;
  written: Array<number>;
  gotCancel: boolean;
  sentClose: boolean;
}

export interface QCfg {
  grace: number;
  connectTimeout: number;
  handshakeTimeout: number;
  backoff: number;
  heartbeat: number;
  heartbeatsUntilDead: number;
  maxStreams: number;
  maxWrites: number;
}

export interface QState {
  cfg: QCfg;
  now: number;
  ids: {
    sess: number;
    conn: number;
    dial: number;
    stream: number;
    timer: number;
  };
  client: {
    session: QOption<QClientSession>;
    attempts: number;
    restoreActive: boolean;
  };
  server: {
    pending: Map<number, { hs: QTimer; gotHandshake: boolean }>;
    session: QOption<QServerSession>;
    tombstones: Array<number>;
    epoch: number;
    closed: boolean;
  };
  conns: Map<number, QConn>;
  dials: Array<number>;
  cStreams: Map<number, QCStream>;
  sStreams: Map<number, QSStream>;
  obs: {
    cErrs: Array<string>;
    sErrs: Array<string>;
    cOoo: number;
    sOoo: number;
    rejections: Array<string>;
  };
}

export type QTimerRef =
  | Variant<'TClientGrace'>
  | Variant<'TClientState'>
  | Variant<'TClientWd'>
  | Variant<'TPendingHs', number>
  | Variant<'TServerGrace'>
  | Variant<'TServerWd'>
  | Variant<'TServerHb'>;

export type QAction =
  | Variant<'AInit'>
  | Variant<'AInvoke', { sid: number; pt: QProcType }>
  | Variant<'AWrite', { sid: number; v: number }>
  | Variant<'AClose', number>
  | Variant<'AFinalize', number>
  | Variant<'ACancel', number>
  | Variant<'ARespond', { sid: number; v: number }>
  | Variant<'ASWrite', { sid: number; v: number }>
  | Variant<'ASClose', number>
  | Variant<'ASCancel', number>
  | Variant<'AThrow', number>
  | Variant<'ADeliver', { conn: number; toServer: boolean }>
  | Variant<'ADrop', { conn: number; toServer: boolean }>
  | Variant<'ABreak', number>
  | Variant<'ACloseEvent', { conn: number; server: boolean }>
  | Variant<'AGarbage', { conn: number; server: boolean }>
  | Variant<'ADialOk', number>
  | Variant<'ADialFail', number>
  | Variant<'ATick', number>
  | Variant<'AFire', QTimerRef>
  | Variant<'ARestart'>
  | Variant<'AServerClose'>
  | Variant<'AHardDisconnect'>;

export interface TraceStep {
  st: QState;
  action: QAction;
}

export interface Trace {
  name: string;
  steps: Array<TraceStep>;
}

/** Decodes Informal Trace Format values into plain JavaScript values. */
export function decodeItf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeItf);
  if (typeof value !== 'object' || value === null) return value;

  const obj = value as Record<string, unknown>;
  if ('#bigint' in obj) return Number(obj['#bigint']);
  if ('#set' in obj) return (obj['#set'] as Array<unknown>).map(decodeItf);
  if ('#tup' in obj) return (obj['#tup'] as Array<unknown>).map(decodeItf);
  if ('#map' in obj) {
    const entries = obj['#map'] as Array<[unknown, unknown]>;

    return new Map(entries.map(([k, v]) => [decodeItf(k), decodeItf(v)]));
  }

  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, decodeItf(v)]),
  );
}

function variable(state: Record<string, unknown>, name: string): unknown {
  for (const [key, value] of Object.entries(state)) {
    if (key === name || key.endsWith(`::${name}`)) return value;
  }

  throw new Error(`trace state has no variable ${name}`);
}

export function parseTrace(name: string, json: string): Trace {
  const itf = JSON.parse(json) as { states: Array<Record<string, unknown>> };

  return {
    name,
    steps: itf.states.map((state) => ({
      st: decodeItf(variable(state, 'st')) as QState,
      action: decodeItf(variable(state, 'lastAction')) as QAction,
    })),
  };
}

export function some<T>(option: QOption<T>): T | null {
  return option.tag === 'Some' ? option.value : null;
}

const clientStateNames: Record<QCState['tag'], string> = {
  CNoConn: 'NoConnection',
  CBackingOff: 'BackingOff',
  CConnecting: 'Connecting',
  CHandshaking: 'Handshaking',
  CConnected: 'Connected',
};

function projectBody(body: QBody): Body {
  switch (body.tag) {
    case 'Heartbeat':
      return { kind: 'Heartbeat' };
    case 'SInit':
      return {
        kind: 'SInit',
        sid: body.value.sid,
        pt: body.value.pt.tag,
        close: body.value.close,
      };
    case 'SData':
      return { kind: 'SData', sid: body.value.sid, v: body.value.v };
    case 'SResult':
      return {
        kind: 'SResult',
        sid: body.value.sid,
        v: body.value.v,
        close: body.value.close,
      };
    case 'SClose':
      return { kind: 'SClose', sid: body.value };
    case 'SCancel':
      return { kind: 'SCancel', sid: body.value.sid, code: body.value.code };
  }
}

function projectMsg(msg: QMsg): Msg {
  return { seq: msg.seq, ack: msg.ack, body: projectBody(msg.body) };
}

function projectFrame(frame: QFrame): Frame {
  switch (frame.tag) {
    case 'HsReq':
      return { kind: 'HsReq', ...frame.value };
    case 'HsResp':
      return { kind: 'HsResp', ...frame.value };
    case 'Data':
      return { kind: 'Data', ...projectMsg(frame.value) };
  }
}

function projectRes(res: QRes): Res {
  return res.tag === 'ROk'
    ? { ok: true, v: res.value }
    : { ok: false, code: res.value };
}

function graceDeadline(grace: QOption<QTimer>): number | null {
  return some(grace)?.at ?? null;
}

function projectClientSession(cs: QClientSession): SessionView {
  const on =
    cs.st.tag === 'CConnecting' ||
    cs.st.tag === 'CHandshaking' ||
    cs.st.tag === 'CConnected'
      ? cs.st.value
      : null;

  return {
    sess: cs.sess,
    state: clientStateNames[cs.st.tag],
    on,
    seq: cs.seq,
    ack: cs.ack,
    seqSent: cs.seqSent,
    buf: cs.buf.map(projectMsg),
    grace: graceDeadline(cs.grace),
  };
}

function projectServerSession(ss: QServerSession): SessionView {
  return {
    sess: ss.sess,
    state: ss.st.tag === 'SConnected' ? 'Connected' : 'NoConnection',
    on: ss.st.tag === 'SConnected' ? ss.st.value : null,
    seq: ss.seq,
    ack: ss.ack,
    seqSent: ss.seqSent,
    buf: ss.buf.map(projectMsg),
    grace: graceDeadline(ss.grace),
  };
}

/** Pending timers in the implementation, including the retry budget's restore interval. */
export function timerCount(st: QState): number {
  const present = (o: QOption<unknown>) => (o.tag === 'Some' ? 1 : 0);
  const cs = some(st.client.session);
  const ss = some(st.server.session);
  const clientTimers = cs
    ? present(cs.grace) + present(cs.stTimer) + present(cs.wd)
    : 0;
  const serverTimers = ss
    ? present(ss.grace) + present(ss.wd) + present(ss.hb)
    : 0;

  return (
    clientTimers +
    st.server.pending.size +
    serverTimers +
    (st.client.restoreActive ? 1 : 0)
  );
}

export function projectModel(st: QState): Projection {
  const conns: Record<string, ConnView> = {};
  for (const [id, conn] of st.conns) {
    conns[id] = {
      toServer: conn.toServer.map(projectFrame),
      toClient: conn.toClient.map(projectFrame),
      closed: conn.closed,
      clientEv: conn.clientEv,
      serverEv: conn.serverEv,
    };
  }

  const cStreams: Record<string, ClientStreamView> = {};
  for (const [sid, c] of st.cStreams) {
    cStreams[sid] = { w: c.w, r: c.r, results: c.results.map(projectRes) };
  }

  const sStreams: Record<string, ServerStreamView> = {};
  for (const [sid, x] of st.sStreams) {
    sStreams[sid] = {
      r: x.r,
      w: x.w,
      inMap: x.inMap,
      runs: x.runs,
      values: x.values.map(projectRes),
    };
  }

  const cs = some(st.client.session);
  const ss = some(st.server.session);

  return {
    now: st.now,
    client: cs ? projectClientSession(cs) : null,
    server: {
      closed: st.server.closed,
      pending: [...st.server.pending.keys()].sort((a, b) => a - b),
      session: ss ? projectServerSession(ss) : null,
      tombstones: [...st.server.tombstones].sort((a, b) => a - b),
    },
    conns,
    dials: [...st.dials].sort((a, b) => a - b),
    cStreams,
    sStreams,
    cErrs: st.obs.cErrs,
    sErrs: st.obs.sErrs,
    cViolations: st.obs.cOoo,
    sViolations: st.obs.sOoo,
    timers: timerCount(st),
  };
}

export function describeAction(action: QAction): string {
  if (Array.isArray(action.value) && action.value.length === 0) {
    return action.tag;
  }

  return `${action.tag}(${JSON.stringify(action.value)})`;
}
