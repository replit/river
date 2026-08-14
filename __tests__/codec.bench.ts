import { bench, describe, vi } from 'vitest';
import { BinaryCodec, CodecMessageAdapter, NaiveJsonCodec } from '../codec';
import { ProtoCodec } from '../protobuf/codec';
import type { OpaqueTransportMessage } from '../transport/message';

// see the note in bandwidth.bench.ts: tinybench measures with `performance.now`,
// which the global setup fakes
vi.useRealTimers();

const BENCH_DURATION = 2_000;

const codecs = [
  { name: 'naive', codec: NaiveJsonCodec },
  { name: 'binary', codec: BinaryCodec },
  { name: 'proto', codec: ProtoCodec },
];

/** A typical procedure response: nested, small, no binary. */
const smallMessage: OpaqueTransportMessage = {
  id: 'abc123def456',
  from: 'client-42',
  to: 'SERVER',
  seq: 1234,
  ack: 1233,
  streamId: 'stream-abcdef',
  controlFlags: 0,
  serviceName: 'documents',
  procedureName: 'applyOperation',
  payload: {
    ok: true,
    payload: {
      revision: 991,
      ops: [{ retain: 40 }, { insert: 'hello world' }, { delete: 3 }],
      author: { id: 'u_123', name: 'someone', roles: ['owner', 'editor'] },
      meta: { ts: 1700000000000, client: 'web' },
    },
  },
};

/** 64KB of binary, which is where the JSON codec's base64 path shows up. */
const binaryMessage: OpaqueTransportMessage = {
  ...smallMessage,
  payload: new Uint8Array(65536).map((_, i) => i % 256),
};

describe('codec -- encode small message', () => {
  for (const { name, codec } of codecs) {
    bench(name, () => void codec.toBuffer(smallMessage), {
      time: BENCH_DURATION,
    });
  }
});

describe('codec -- decode small message', () => {
  for (const { name, codec } of codecs) {
    const bytes = codec.toBuffer(smallMessage);
    bench(name, () => void codec.fromBuffer(bytes), { time: BENCH_DURATION });
  }
});

describe('codec -- encode 64KB binary payload', () => {
  for (const { name, codec } of codecs) {
    bench(name, () => void codec.toBuffer(binaryMessage), {
      time: BENCH_DURATION,
    });
  }
});

describe('codec -- decode 64KB binary payload', () => {
  for (const { name, codec } of codecs) {
    const bytes = codec.toBuffer(binaryMessage);
    bench(name, () => void codec.fromBuffer(bytes), { time: BENCH_DURATION });
  }
});

/**
 * The adapter is what the session actually calls, so it carries schema
 * validation on top of the codec. That validation runs per inbound message and
 * is the reason servers compile their validator.
 */
describe('adapter -- decode + validate small message (binary codec)', () => {
  const interpreted = new CodecMessageAdapter(BinaryCodec);
  const compiled = new CodecMessageAdapter(BinaryCodec, {
    precompileValidator: true,
  });
  const bytes = BinaryCodec.toBuffer(smallMessage);

  bench(
    'interpreted validator (client)',
    () => void interpreted.fromBuffer(bytes),
    {
      time: BENCH_DURATION,
    },
  );
  bench('compiled validator (server)', () => void compiled.fromBuffer(bytes), {
    time: BENCH_DURATION,
  });
});
