import type { Clock } from '@sinonjs/fake-timers';
import { Type } from 'typebox';
import { Ok, Procedure, createServiceSchema, type Result } from '../../router';
import { createClient } from '../../router/client';
import { createServer } from '../../router/server';
import { NaiveJsonCodec } from '../../codec/json';
import type { Codec } from '../../codec/types';
import {
  ControlFlags,
  type OpaqueTransportMessage,
} from '../../transport/message';
import { SessionState } from '../../transport/sessionStateMachine/common';
import {
  ScriptedClientTransport,
  ScriptedNetwork,
  ScriptedServerTransport,
} from './network';
import { some, type QAction, type QCfg, type QState } from './model';
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

export const CLIENT_ID = 'client';
export const SERVER_ID = 'SERVER';

const Init = Type.Object({ sid: Type.Number() });
const Payload = Type.Object({ v: Type.Number() });
const ServiceSchema = createServiceSchema();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((err: Error) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) throw new Error('unreachable');

  return { promise, resolve, reject };
}

function toRes(result: unknown): Res {
  const r = result as {
    ok: boolean;
    payload: { v?: number; code?: string };
  };

  return r.ok
    ? { ok: true, v: r.payload.v ?? Number.NaN }
    : { ok: false, code: r.payload.code ?? '' };
}

function isClosed(readable: object): boolean {
  return (readable as { isClosed: () => boolean }).isClosed();
}

/** Consumes a readable in the background, recording everything it yields. */
function drain(readable: object, into: Array<Res>) {
  void (async () => {
    for await (const result of readable as AsyncIterable<unknown>) {
      into.push(toRes(result));
    }
  })();
}

/**
 * Handles on one server-side procedure invocation. Handlers stay pending until
 * the trace resolves or rejects them, so the trace decides when servers reply.
 */
interface ServerRecord {
  respond: (v: number) => void;
  fail: () => void;
  cancel: () => void;
  write?: (v: number) => void;
  closeWritable?: () => void;
  writable?: () => boolean;
  readableClosed?: () => boolean;
  values?: Array<Res>;
}

interface ClientRecord {
  abort: AbortController;
  write?: (v: number) => void;
  close?: () => void;
  writable?: () => boolean;
  readableClosed?: () => boolean;
  results: Array<Res>;
  /** The awaited result of an rpc, or of an upload once finalized. */
  single?: { settled: boolean; value: Res | null };
}

const unexpected = () => {
  throw new Error('model asked this procedure type for something it cannot do');
};

function makeServices(h: Harness) {
  return {
    svc: ServiceSchema.define({
      rpc: Procedure.rpc({
        requestInit: Init,
        responseData: Payload,
        handler: async ({ ctx, reqInit }) => {
          const done = deferred<Result<{ v: number }, never>>();
          h.registerServer(reqInit.sid, {
            respond: (v) => {
              done.resolve(Ok({ v }));
            },
            fail: () => {
              done.reject(new Error('handler threw'));
            },
            cancel: () => {
              ctx.cancel();
            },
          });

          return done.promise;
        },
      }),
      stream: Procedure.stream({
        requestInit: Init,
        requestData: Payload,
        responseData: Payload,
        handler: async ({ ctx, reqInit, reqReadable, resWritable }) => {
          const done = deferred<undefined>();
          const values: Array<Res> = [];
          h.registerServer(reqInit.sid, {
            respond: unexpected,
            fail: () => {
              done.reject(new Error('handler threw'));
            },
            cancel: () => {
              ctx.cancel();
            },
            write: (v) => {
              resWritable.write(Ok({ v }));
            },
            closeWritable: () => {
              resWritable.close();
            },
            writable: () => resWritable.isWritable(),
            readableClosed: () => isClosed(reqReadable),
            values,
          });
          drain(reqReadable, values);

          return done.promise;
        },
      }),
      upload: Procedure.upload({
        requestInit: Init,
        requestData: Payload,
        responseData: Payload,
        handler: async ({ ctx, reqInit, reqReadable }) => {
          const done = deferred<Result<{ v: number }, never>>();
          const values: Array<Res> = [];
          h.registerServer(reqInit.sid, {
            respond: (v) => {
              done.resolve(Ok({ v }));
            },
            fail: () => {
              done.reject(new Error('handler threw'));
            },
            cancel: () => {
              ctx.cancel();
            },
            readableClosed: () => isClosed(reqReadable),
            values,
          });
          drain(reqReadable, values);

          return done.promise;
        },
      }),
      sub: Procedure.subscription({
        requestInit: Init,
        responseData: Payload,
        handler: async ({ ctx, reqInit, resWritable }) => {
          const done = deferred<undefined>();
          h.registerServer(reqInit.sid, {
            respond: unexpected,
            fail: () => {
              done.reject(new Error('handler threw'));
            },
            cancel: () => {
              ctx.cancel();
            },
            write: (v) => {
              resWritable.write(Ok({ v }));
            },
            closeWritable: () => {
              resWritable.close();
            },
            writable: () => resWritable.isWritable(),
          });

          return done.promise;
        },
      }),
    }),
  };
}

type Services = ReturnType<typeof makeServices>;

interface RouterInternals {
  streams: Map<string, unknown>;
  serverCancelledStreams: Map<string, { items: Set<string> }>;
}

const procTags: Record<string, ProcTag> = {
  rpc: 'PRpc',
  stream: 'PStream',
  upload: 'PUpload',
  sub: 'PSubscription',
};

/** Lets every pending promise callback run, without touching fake timers. */
export function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * The system under test: a real client and server transport, router, and
 * client, wired through a {@link ScriptedNetwork}, running on a fake clock that
 * only advances when the trace says so.
 */
export class Harness {
  readonly network = new ScriptedNetwork();
  readonly clientTransport: ScriptedClientTransport;
  serverTransport: ScriptedServerTransport;
  private readonly client: ReturnType<typeof createClient<Services>>;
  private server: ReturnType<typeof createServer>;
  private readonly sessionOptions;
  private readonly codec: Codec;
  private readonly clock: Clock;
  private readonly t0 = Date.now();

  private readonly cErrs: Array<string> = [];
  private readonly sErrs: Array<string> = [];
  private cViolations = 0;
  private sViolations = 0;

  /** Real session and stream ids, mapped to the model's integers. */
  private readonly sessIds = new Map<string, number>();
  private readonly streamIds = new Map<string, number>();
  private readonly realStreamIds = new Map<number, string>();

  private readonly clientRecords = new Map<number, ClientRecord>();
  private serverRecords = new Map<number, ServerRecord>();

  constructor(cfg: QCfg, clock: Clock, codec: Codec = NaiveJsonCodec) {
    this.clock = clock;
    this.codec = codec;
    this.sessionOptions = {
      codec,
      heartbeatIntervalMs: cfg.heartbeat,
      heartbeatsUntilDead: cfg.heartbeatsUntilDead,
      sessionDisconnectGraceMs: cfg.grace,
      connectionTimeoutMs: cfg.connectTimeout,
      handshakeTimeoutMs: cfg.handshakeTimeout,
      enableTransparentSessionReconnects: true,
    };

    this.clientTransport = new ScriptedClientTransport(
      CLIENT_ID,
      this.network,
      {
        ...this.sessionOptions,
        baseIntervalMs: cfg.backoff,
        maxBackoffMs: cfg.backoff,
        maxJitterMs: 0,
        attemptBudgetCapacity: Number.MAX_SAFE_INTEGER,
        // the restore interval never fires within a trace
        budgetRestoreIntervalMs: 1_000_000_000,
      },
    );
    this.clientTransport.bindLogger((_msg, ctx) => {
      if (ctx?.tags?.includes('invariant-violation')) this.cViolations++;
    }, 'warn');
    this.clientTransport.addEventListener('protocolError', (evt) => {
      this.cErrs.push(evt.type as unknown as string);
    });

    this.client = createClient<Services>(this.clientTransport, SERVER_ID, {
      eagerlyConnect: false,
    });

    const { transport, server } = this.startServer();
    this.serverTransport = transport;
    this.server = server;
  }

  private startServer() {
    const transport = new ScriptedServerTransport(
      SERVER_ID,
      this.network,
      this.sessionOptions,
    );
    transport.bindLogger((_msg, ctx) => {
      if (ctx?.tags?.includes('invariant-violation')) this.sViolations++;
    }, 'warn');
    transport.addEventListener('protocolError', (evt) => {
      this.sErrs.push(evt.type as unknown as string);
    });

    return { transport, server: createServer(transport, makeServices(this)) };
  }

  registerServer(sid: number, record: ServerRecord) {
    this.serverRecords.set(sid, record);
  }

  private clientRecord(sid: number): ClientRecord {
    const record = this.clientRecords.get(sid);
    if (!record) throw new Error(`no client stream ${sid}`);

    return record;
  }

  private serverRecord(sid: number): ServerRecord {
    const record = this.serverRecords.get(sid);
    if (!record) throw new Error(`no server stream ${sid}`);

    return record;
  }

  async apply(action: QAction) {
    switch (action.tag) {
      case 'AInit':
        break;
      case 'AInvoke':
        this.invoke(action.value.sid, action.value.pt.tag);
        break;
      case 'AWrite':
        (this.clientRecord(action.value.sid).write ?? unexpected)(
          action.value.v,
        );
        break;
      case 'AClose':
        (this.clientRecord(action.value).close ?? unexpected)();
        break;
      case 'ACancel':
        this.clientRecord(action.value).abort.abort();
        break;
      case 'ARespond':
        this.serverRecord(action.value.sid).respond(action.value.v);
        break;
      case 'ASWrite':
        (this.serverRecord(action.value.sid).write ?? unexpected)(
          action.value.v,
        );
        break;
      case 'ASClose':
        (this.serverRecord(action.value).closeWritable ?? unexpected)();
        break;
      case 'ASCancel':
        this.serverRecord(action.value).cancel();
        break;
      case 'AThrow':
        this.serverRecord(action.value).fail();
        break;
      case 'ADeliver':
        this.network.deliver(action.value.conn, action.value.toServer);
        break;
      case 'ADrop':
        this.network.drop(action.value.conn, action.value.toServer);
        break;
      case 'ABreak':
        this.network.close(action.value);
        break;
      case 'ACloseEvent':
        this.network.closeEvent(action.value.conn, action.value.server);
        break;
      case 'AGarbage':
        this.network.garbage(action.value.conn, action.value.server);
        break;
      case 'ADialOk':
        this.network.completeDial(action.value);
        break;
      case 'ADialFail':
        this.network.failDial(action.value);
        break;
      case 'ATick':
        this.clock.tick(action.value);
        break;
      case 'AFire':
        // exactly one timer: same-instant timers are separate model steps
        this.clock.next();
        break;
      case 'ARestart':
        this.restartServer();
        break;
      case 'AServerClose':
        this.serverTransport.close();
        break;
      case 'AHardDisconnect':
        this.clientTransport.hardDisconnect();
        break;
    }

    await flush();
  }

  private invoke(sid: number, pt: ProcTag) {
    const abort = new AbortController();
    const options = { signal: abort.signal };
    const init = { sid };
    const record: ClientRecord = { abort, results: [] };
    const settle = (res: unknown) => {
      record.single = { settled: true, value: toRes(res) };
    };

    switch (pt) {
      case 'PRpc': {
        record.single = { settled: false, value: null };
        void this.client.svc.rpc.rpc(init, options).then(settle);
        break;
      }
      case 'PStream': {
        const { reqWritable, resReadable } = this.client.svc.stream.stream(
          init,
          options,
        );
        record.write = (v) => {
          reqWritable.write({ v });
        };
        record.close = () => {
          reqWritable.close();
        };
        record.writable = () => reqWritable.isWritable();
        record.readableClosed = () => isClosed(resReadable);
        drain(resReadable, record.results);
        break;
      }
      case 'PUpload': {
        const { reqWritable, finalize } = this.client.svc.upload.upload(
          init,
          options,
        );
        record.write = (v) => {
          reqWritable.write({ v });
        };
        record.close = () => {
          record.single = { settled: false, value: null };
          void finalize().then(settle);
        };
        record.writable = () => reqWritable.isWritable();
        break;
      }
      case 'PSubscription': {
        const { resReadable } = this.client.svc.sub.subscribe(init, options);
        record.readableClosed = () => isClosed(resReadable);
        drain(resReadable, record.results);
        break;
      }
    }

    this.clientRecords.set(sid, record);
    this.learnStreamId(sid);
  }

  /** The init message an invocation just buffered carries the real stream id. */
  private learnStreamId(sid: number) {
    const session = this.clientTransport.sessions.get(SERVER_ID);
    for (const encoded of session?.sendBuffer ?? []) {
      const payload = encoded.msg.payload as { sid?: unknown } | null;
      if (payload?.sid === sid) {
        this.streamIds.set(encoded.msg.streamId, sid);
        this.realStreamIds.set(sid, encoded.msg.streamId);

        return;
      }
    }

    throw new Error(`no init message buffered for stream ${sid}`);
  }

  private restartServer() {
    this.network.crashServer();
    this.serverTransport.crash();
    this.serverRecords = new Map();
    const { transport, server } = this.startServer();
    this.serverTransport = transport;
    this.server = server;
  }

  dispose() {
    try {
      this.clientTransport.close();
      this.serverTransport.close();
    } catch {
      // teardown after a divergence may hit inconsistent state; nothing to report
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  // Projection
  //////////////////////////////////////////////////////////////////////////////

  /**
   * Model and implementation name sessions differently; the first time a real
   * session appears where the model has one, they are unified.
   */
  private sessFor(realId: string, modelSess: number | undefined): number {
    const known = this.sessIds.get(realId);
    if (known !== undefined) return known;
    if (modelSess === undefined) return -1;
    if ([...this.sessIds.values()].includes(modelSess)) return -1;
    this.sessIds.set(realId, modelSess);

    return modelSess;
  }

  private decode(bytes: Uint8Array): OpaqueTransportMessage {
    return this.codec.fromBuffer(bytes) as OpaqueTransportMessage;
  }

  private projectBody(msg: OpaqueTransportMessage, toServer: boolean): Body {
    const flags = msg.controlFlags;
    const has = (bit: ControlFlags) => (flags & bit) !== 0;
    const payload = msg.payload as Record<string, unknown>;
    if (has(ControlFlags.AckBit)) return { kind: 'Heartbeat' };
    if (has(ControlFlags.StreamOpenBit)) {
      return {
        kind: 'SInit',
        sid: payload.sid as number,
        pt: procTags[msg.procedureName ?? ''],
        close: has(ControlFlags.StreamClosedBit),
      };
    }

    const sid = this.streamIds.get(msg.streamId) ?? -1;
    if (has(ControlFlags.StreamCancelBit)) {
      const err = payload.payload as { code: string };

      return { kind: 'SCancel', sid, code: err.code };
    }

    if (has(ControlFlags.StreamClosedBit) && payload.type === 'CLOSE') {
      return { kind: 'SClose', sid };
    }

    if (toServer) return { kind: 'SData', sid, v: payload.v as number };
    const ok = payload.payload as { v: number };

    return {
      kind: 'SResult',
      sid,
      v: ok.v,
      close: has(ControlFlags.StreamClosedBit),
    };
  }

  private projectMsg(bytes: Uint8Array, toServer: boolean): Msg {
    const msg = this.decode(bytes);

    return {
      seq: msg.seq,
      ack: msg.ack,
      body: this.projectBody(msg, toServer),
    };
  }

  private projectFrame(bytes: Uint8Array, toServer: boolean): Frame {
    const msg = this.decode(bytes);
    const payload = msg.payload as Record<string, unknown> | null;
    if (payload?.type === 'HANDSHAKE_REQ') {
      const expected = payload.expectedSessionState as {
        nextExpectedSeq: number;
        nextSentSeq: number;
      };

      return {
        kind: 'HsReq',
        sess: this.sessIds.get(payload.sessionId as string) ?? -1,
        nextExpectedSeq: expected.nextExpectedSeq,
        nextSentSeq: expected.nextSentSeq,
      };
    }

    if (payload?.type === 'HANDSHAKE_RESP') {
      const status = payload.status as {
        ok: boolean;
        sessionId?: string;
        code?: string;
      };

      return status.ok
        ? {
            kind: 'HsResp',
            ok: true,
            sess: this.sessIds.get(status.sessionId ?? '') ?? -1,
            code: '',
          }
        : { kind: 'HsResp', ok: false, sess: 0, code: status.code ?? '' };
    }

    return {
      kind: 'Data',
      seq: msg.seq,
      ack: msg.ack,
      body: this.projectBody(msg, toServer),
    };
  }

  private projectClient(model: QState): SessionView | null {
    const session = this.clientTransport.sessions.get(SERVER_ID);
    if (!session) return null;

    const sess = this.sessFor(session.id, some(model.client.session)?.sess);
    const buf = session.sendBuffer.map((m) => this.projectMsg(m.data, true));
    const common = {
      sess,
      state: session.state as string,
      seq: session.seq,
      ack: session.ack,
      seqSent: session.seqSent,
      buf,
    };

    switch (session.state) {
      case SessionState.Connected:
        return { ...common, on: session.conn.linkId, grace: null };
      case SessionState.Handshaking:
        return {
          ...common,
          on: session.conn.linkId,
          grace: session.graceExpiryTime - this.t0,
        };
      case SessionState.Connecting:
        return {
          ...common,
          on: this.network.lastDial,
          grace: session.graceExpiryTime - this.t0,
        };
      case SessionState.NoConnection:
      case SessionState.BackingOff:
        return {
          ...common,
          on: null,
          grace: session.graceExpiryTime - this.t0,
        };
    }
  }

  private projectServer(model: QState): SessionView | null {
    const session = this.serverTransport.sessions.get(CLIENT_ID);
    if (!session) return null;

    const common = {
      sess: this.sessFor(session.id, some(model.server.session)?.sess),
      state: session.state as string,
      seq: session.seq,
      ack: session.ack,
      seqSent: session.seqSent,
      buf: session.sendBuffer.map((m) => this.projectMsg(m.data, false)),
    };

    return session.state === SessionState.Connected
      ? { ...common, on: session.conn.linkId, grace: null }
      : { ...common, on: null, grace: session.graceExpiryTime - this.t0 };
  }

  private projectClientStream(record: ClientRecord): ClientStreamView {
    const { single, readableClosed } = record;
    if (readableClosed) {
      return {
        w: record.writable?.() ?? null,
        r: !readableClosed(),
        results: [...record.results],
      };
    }

    return {
      w: record.writable?.() ?? null,
      r: single ? !single.settled : null,
      results: single ? (single.value ? [single.value] : []) : null,
    };
  }

  project(model: QState): Projection {
    const router = this.server as unknown as RouterInternals;

    const conns: Record<string, ConnView> = {};
    for (const link of this.network.links.values()) {
      conns[link.id] = {
        toServer: link.toServer.map((b) => this.projectFrame(b, true)),
        toClient: link.toClient.map((b) => this.projectFrame(b, false)),
        closed: link.closed,
        clientEv: link.clientEv,
        serverEv: link.serverEv,
      };
    }

    const cStreams: Record<string, ClientStreamView> = {};
    for (const [sid, record] of this.clientRecords) {
      cStreams[sid] = this.projectClientStream(record);
    }

    const sStreams: Record<string, ServerStreamView> = {};
    for (const [sid, record] of this.serverRecords) {
      const realId = this.realStreamIds.get(sid) ?? '';
      sStreams[sid] = {
        r: record.readableClosed ? !record.readableClosed() : null,
        w: record.writable?.() ?? null,
        inMap: router.streams.has(realId),
        values: record.values ? [...record.values] : null,
      };
    }

    const tombstones = router.serverCancelledStreams.get(CLIENT_ID)?.items;

    return {
      now: Date.now() - this.t0,
      client: this.projectClient(model),
      server: {
        closed: this.serverTransport.getStatus() === 'closed',
        pending: Array.from(
          this.serverTransport.pendingSessions,
          (pending) => pending.conn.linkId,
        ).sort((a, b) => a - b),
        session: this.projectServer(model),
        tombstones: Array.from(
          tombstones ?? [],
          (id) => this.streamIds.get(id) ?? -1,
        ).sort((a, b) => a - b),
      },
      conns,
      dials: [...this.network.dials.keys()].sort((a, b) => a - b),
      cStreams,
      sStreams,
      cErrs: [...this.cErrs],
      sErrs: [...this.sErrs],
      cViolations: this.cViolations,
      sViolations: this.sViolations,
      timers: this.clock.countTimers(),
    };
  }
}
