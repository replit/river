import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Codec } from '../../codec';
import type { Connection } from '../../transport/connection';
import type { Transport } from '../../transport/transport';
import type { LogFn, MessageMetadata } from '../../logging/log';
import type {
  OpaqueTransportMessage,
  TransportClientId,
} from '../../transport/message';

/**
 * Test-only execution tracing for runtime conformance checking against the P
 * model (verification/p/PObs, run via PObserve — see
 * verification/p/observe.sh).
 *
 * Enabled by setting RIVER_TRACE_DIR; otherwise every hook is a no-op. When
 * enabled, each mock network (i.e. each generated property-test case) writes
 * one JSONL file of transport-level records: encoded/accepted frames with
 * seq/ack/flags, session lifecycle events, and the transport's own
 * invariant-violation log lines. Records carry a process-monotonic counter
 * `n` as the ordering key (the test clock is faked and jumps).
 */

type TraceSide = 'client' | 'server';

const traceDir = process.env.RIVER_TRACE_DIR;
let counter = 0;
let caseSeq = 0;
let currentFile: string | undefined;
let currentRun = '';

export function tracingEnabled(): boolean {
  return traceDir !== undefined && traceDir !== '';
}

/** Start a fresh trace file. Called once per mock network construction. */
export function startTraceCase(): void {
  if (!traceDir) return;
  mkdirSync(traceDir, { recursive: true });
  currentRun = `${process.pid}-${caseSeq++}`;
  currentFile = join(traceDir, `${currentRun}.jsonl`);
}

function emit(rec: Record<string, unknown>): void {
  if (!traceDir || !currentFile) return;
  appendFileSync(
    currentFile,
    `${JSON.stringify({ n: counter++, run: currentRun, ...rec })}\n`,
  );
}

function isHandshakePayload(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'type' in payload &&
    ((payload as { type: unknown }).type === 'HANDSHAKE_REQ' ||
      (payload as { type: unknown }).type === 'HANDSHAKE_RESP')
  );
}

/**
 * Wrap a codec so every outbound frame is recorded at encode time.
 * Handshake frames are out-of-band (seq 0/ack 0) and skipped. Retransmits
 * reuse the cached encoding and deliberately do not re-appear here.
 */
export function traceWrapCodec(side: TraceSide, inner: Codec): Codec {
  if (!tracingEnabled()) return inner;

  return {
    toBuffer(msg) {
      const m = msg as Partial<OpaqueTransportMessage>;
      if (!isHandshakePayload(m.payload) && typeof m.seq === 'number') {
        emit({
          side,
          k: 'enc',
          seq: m.seq,
          ack: m.ack,
          streamId: m.streamId,
          controlFlags: m.controlFlags,
        });
      }

      return inner.toBuffer(msg);
    },
    fromBuffer: (buf) => inner.fromBuffer(buf),
  };
}

/** Subscribe to a transport's lifecycle events. */
export function attachTraceEvents(
  side: TraceSide,
  transport: Transport<Connection>,
): void {
  if (!tracingEnabled()) return;

  transport.addEventListener('sessionStatus', (evt) => {
    // snapshot synchronously: session handles throw once consumed
    if (evt.status === 'closed') {
      emit({ side, k: 'sclosed', sessionId: evt.session.id });

      return;
    }

    emit({
      side,
      k: evt.status === 'created' ? 'screate' : 'sclosing',
      sessionId: evt.session.id,
      state: evt.session.state,
    });
  });
  transport.addEventListener('sessionTransition', (evt) => {
    emit({ side, k: 'strans', sessionId: evt.id, state: evt.state });
  });
  transport.addEventListener('protocolError', (evt) => {
    emit({ side, k: 'perr', type: evt.type, message: evt.message });
  });
}

/**
 * A log function that records the transport's per-message narrative
 * (accepted frames, out-of-order receives, invariant violations) and also
 * collects `invariant-violation` lines the way the property tests expect.
 */
export function traceLogFn(side: TraceSide, violations: Array<string>): LogFn {
  return (msg: string, ctx?: MessageMetadata, level?: string) => {
    if (ctx?.tags?.includes('invariant-violation')) {
      violations.push(`[${level ?? '?'}] ${msg}`);
      emit({ side, k: 'inv', message: msg });
    }
    if (!tracingEnabled()) return;

    if (msg === 'received msg' && ctx?.transportMessage) {
      const m = ctx.transportMessage;
      emit({
        side,
        k: 'acc',
        seq: m.seq,
        ack: m.ack,
        streamId: m.streamId,
        controlFlags: m.controlFlags,
        sessionId: ctx.sessionId,
      });
    } else if (msg.startsWith('received out-of-order msg')) {
      const m = ctx?.transportMessage;
      emit({
        side,
        k: 'ooo',
        seq: m?.seq,
        ack: m?.ack,
        streamId: m?.streamId,
        sessionId: ctx?.sessionId,
      });
    }
  };
}

/** Which side a transport is, by the property suite's naming convention. */
export function traceSideOf(clientId: TransportClientId): TraceSide {
  return clientId === 'SERVER' ? 'server' : 'client';
}
