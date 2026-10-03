/**
 * The comparable view of a protocol state. The model (spec/river.qnt) and the
 * TypeScript implementation are each projected into this shape after every
 * step of a trace, and the two projections must be equal.
 */

export type Body =
  | { kind: 'Heartbeat' }
  | { kind: 'SInit'; sid: number; pt: ProcTag; close: boolean }
  | { kind: 'SData'; sid: number; v: number }
  | { kind: 'SResult'; sid: number; v: number; close: boolean }
  | { kind: 'SClose'; sid: number }
  | { kind: 'SCancel'; sid: number; code: string };

export type ProcTag = 'PRpc' | 'PStream' | 'PUpload' | 'PSubscription';

export interface Msg {
  seq: number;
  ack: number;
  body: Body;
}

export type Frame =
  | {
      kind: 'HsReq';
      sess: number;
      nextExpectedSeq: number;
      nextSentSeq: number;
    }
  | { kind: 'HsResp'; ok: boolean; sess: number; code: string }
  | ({ kind: 'Data' } & Msg);

export type Res = { ok: true; v: number } | { ok: false; code: string };

export interface SessionView {
  sess: number;
  state: string;
  /** The dial a Connecting session waits on, or the connection otherwise. */
  on: number | null;
  seq: number;
  ack: number;
  seqSent: number;
  buf: Array<Msg>;
  grace: number | null;
}

export interface ConnView {
  toServer: Array<Frame>;
  toClient: Array<Frame>;
  closed: boolean;
  clientEv: boolean;
  serverEv: boolean;
}

/** `null` marks a field the implementation does not expose for this procedure type. */
export interface ClientStreamView {
  w: boolean | null;
  r: boolean | null;
  results: Array<Res> | null;
}

export interface ServerStreamView {
  r: boolean | null;
  w: boolean | null;
  inMap: boolean;
  values: Array<Res> | null;
}

export interface Projection {
  now: number;
  client: SessionView | null;
  server: {
    closed: boolean;
    pending: Array<number>;
    session: SessionView | null;
    tombstones: Array<number>;
  };
  conns: Record<string, ConnView>;
  dials: Array<number>;
  cStreams: Record<string, ClientStreamView>;
  sStreams: Record<string, ServerStreamView>;
  cErrs: Array<string>;
  sErrs: Array<string>;
  cViolations: number;
  sViolations: number;
  timers: number;
}

/**
 * Hides from the model projection the stream fields the implementation cannot
 * observe, so they don't count as differences.
 */
export function maskUnobservable(model: Projection, impl: Projection) {
  for (const [sid, view] of Object.entries(impl.cStreams)) {
    const modelView = model.cStreams[sid] as ClientStreamView | undefined;
    if (!modelView) continue;
    if (view.w === null) modelView.w = null;
    if (view.r === null) modelView.r = null;
    if (view.results === null) modelView.results = null;
  }

  for (const [sid, view] of Object.entries(impl.sStreams)) {
    const modelView = model.sStreams[sid] as ServerStreamView | undefined;
    if (!modelView) continue;
    if (view.r === null) modelView.r = null;
    if (view.w === null) modelView.w = null;
    if (view.values === null) modelView.values = null;
  }
}

export interface Difference {
  path: string;
  model: unknown;
  impl: unknown;
}

/** Every leaf where the two values differ, keyed by its path. */
export function diff(
  model: unknown,
  impl: unknown,
  path = '',
): Array<Difference> {
  if (Object.is(model, impl)) return [];

  const bothObjects =
    typeof model === 'object' &&
    typeof impl === 'object' &&
    model !== null &&
    impl !== null &&
    Array.isArray(model) === Array.isArray(impl);
  if (!bothObjects) return [{ path: path || '.', model, impl }];

  if (Array.isArray(model) && Array.isArray(impl)) {
    if (model.length !== impl.length) {
      return [{ path: path || '.', model, impl }];
    }

    return model.flatMap((item, i) => diff(item, impl[i], `${path}[${i}]`));
  }

  const left = model as Record<string, unknown>;
  const right = impl as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

  return [...keys]
    .sort()
    .flatMap((key) => diff(left[key], right[key], `${path}.${key}`));
}
