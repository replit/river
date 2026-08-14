import { describe, expect, test } from 'vitest';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import {
  BinaryCodec,
  Codec,
  CodecMessageAdapter,
  NaiveJsonCodec,
} from '../../codec';
import { ProtoCodec } from '../../protobuf/codec';
import { OpaqueTransportMessage } from '../../transport/message';

/** Round-trip properties for the codecs. See ./README.md for the catalog. */

const codecs: Array<{ name: string; codec: Codec }> = [
  { name: 'naive', codec: NaiveJsonCodec },
  { name: 'binary', codec: BinaryCodec },
  { name: 'proto', codec: ProtoCodec },
];

// Every constraint on the generators below is a real limitation, each pinned by
// a test in 'documented codec limitations'. Widening them should fail.
//
// `$t`/`$b` used to live here too -- NaiveJsonCodec's markers collided with
// application data -- until the codec started escaping them.
const UNROUNDTRIPPABLE_KEYS = ['__proto__'];
const MAX_UINT32 = 0xffffffff;

const identifiers = gs.text({ codec: 'utf-8', minSize: 1, maxSize: 24 });
const seqNumbers = gs.integers({ minValue: 0, maxValue: MAX_UINT32 });

const payloadKeys = identifiers.filter(
  (key) => !UNROUNDTRIPPABLE_KEYS.includes(key),
);

const payloadLeaves = gs.oneOf<unknown>(
  gs.integers({ minValue: -1_000_000, maxValue: 1_000_000 }),
  gs.floats({ minValue: -1e6, maxValue: 1e6 }).filter((n) => !Object.is(n, -0)),
  gs.booleans(),
  gs.text({ codec: 'utf-8', maxSize: 24 }),
  gs.just(null),
  // hegel hands back a node Buffer, and toStrictEqual distinguishes it from a
  // plain Uint8Array by prototype
  gs.binary({ maxSize: 8 }).map((buf) => new Uint8Array(buf)),
);

function payloadValues(depth: number): gs.Generator<unknown> {
  if (depth <= 0) {
    return payloadLeaves;
  }

  const inner = payloadValues(depth - 1);

  return gs.oneOf<unknown>(
    payloadLeaves,
    gs.arrays(inner, { maxSize: 4 }),
    gs
      .arrays(gs.tuples(payloadKeys, inner), { maxSize: 4 })
      .map((entries) => Object.fromEntries(entries)),
  );
}

const payloads = gs.oneOf<unknown>(
  payloadValues(3),
  // control-message-shaped payloads, which is most real traffic
  gs
    .sampledFrom(['ACK', 'CLOSE', 'HANDSHAKE_REQ', 'REHANDSHAKE_REQ'])
    .map((type) => ({ type })),
);

const transportMessages: gs.Generator<OpaqueTransportMessage> = gs.composite(
  (tc) => {
    const msg: OpaqueTransportMessage = {
      id: tc.draw(identifiers),
      from: tc.draw(identifiers),
      to: tc.draw(identifiers),
      seq: tc.draw(seqNumbers),
      ack: tc.draw(seqNumbers),
      streamId: tc.draw(identifiers),
      controlFlags: tc.draw(gs.integers({ minValue: 0, maxValue: 0b1111 })),
      payload: tc.draw(payloads),
    };

    // present-or-absent, not present-or-null: PROTOCOL.md lets every message
    // after the first omit these, which is what A2 checks
    if (tc.draw(gs.booleans())) {
      msg.serviceName = tc.draw(identifiers);
    }

    if (tc.draw(gs.booleans())) {
      msg.procedureName = tc.draw(identifiers);
    }

    if (tc.draw(gs.booleans())) {
      msg.tracing = {
        traceparent: tc.draw(gs.text({ codec: 'utf-8', maxSize: 55 })),
        tracestate: tc.draw(gs.text({ codec: 'utf-8', maxSize: 55 })),
      };
    }

    return msg;
  },
);

describe.each(codecs)('codec properties -- $name', ({ codec }) => {
  test('A1: encoding then decoding any transport message is the identity', () =>
    hegel.testAsync((tc) => {
      const msg = tc.draw(transportMessages);
      tc.note(`message: ${JSON.stringify(msg, bigintSafe)}`);

      expect(codec.fromBuffer(codec.toBuffer(msg))).toStrictEqual(msg);
    }));

  test('A2: absent optional fields stay absent', () =>
    hegel.testAsync((tc) => {
      const msg = tc.draw(transportMessages);
      delete msg.serviceName;
      delete msg.procedureName;
      delete msg.tracing;

      const decoded = codec.fromBuffer(codec.toBuffer(msg));

      expect(decoded).not.toHaveProperty('serviceName');
      expect(decoded).not.toHaveProperty('procedureName');
      expect(decoded).not.toHaveProperty('tracing');
    }));

  test('A3: every control flag combination survives', () =>
    hegel.testAsync((tc) => {
      const msg = tc.draw(transportMessages);
      msg.controlFlags = tc.draw(
        gs.integers({ minValue: 0, maxValue: 0b1111 }),
      );

      const decoded = codec.fromBuffer(
        codec.toBuffer(msg),
      ) as OpaqueTransportMessage;

      expect(decoded.controlFlags).toBe(msg.controlFlags);
    }));

  test('A5: seq and ack survive their full supported range', () =>
    hegel.testAsync((tc) => {
      const msg = tc.draw(transportMessages);
      msg.seq = tc.draw(seqNumbers);
      msg.ack = tc.draw(seqNumbers);

      const decoded = codec.fromBuffer(
        codec.toBuffer(msg),
      ) as OpaqueTransportMessage;

      expect(decoded.seq).toBe(msg.seq);
      expect(decoded.ack).toBe(msg.ack);
    }));

  test('A6: encoding is deterministic', () =>
    hegel.testAsync((tc) => {
      const msg = tc.draw(transportMessages);

      expect(codec.toBuffer(msg)).toStrictEqual(codec.toBuffer(msg));
    }));

  test('A7: decoding arbitrary bytes throws rather than returning a non-object', () =>
    hegel.testAsync((tc) => {
      const bytes = tc.draw(gs.binary({ maxSize: 64 }));

      let decoded: unknown;
      try {
        decoded = codec.fromBuffer(bytes);
      } catch {
        // the expected outcome for almost all inputs; the transport treats a
        // decode failure as an invalid message
        return;
      }

      // if it did decode, the transport will index into it without checking
      expect(typeof decoded).toBe('object');
      expect(decoded).not.toBeNull();
    }));
});

describe('bigint payloads (naive and binary only)', () => {
  // ProtoCodec msgpacks non-binary payloads without BinaryCodec's bigint
  // extension, so bigints are out of scope for it
  test.each([
    { name: 'naive', codec: NaiveJsonCodec },
    { name: 'binary', codec: BinaryCodec },
  ])('A4: bigints survive a round-trip -- $name', ({ codec }) =>
    hegel.testAsync((tc) => {
      const value = tc.draw(
        gs.bigIntegers({
          minValue: -(2n ** 80n),
          maxValue: 2n ** 80n,
        }),
      );
      const msg = { ...tc.draw(transportMessages), payload: { value } };

      const decoded = codec.fromBuffer(
        codec.toBuffer(msg),
      ) as OpaqueTransportMessage;

      expect((decoded.payload as { value: bigint }).value).toBe(value);
    }),
  );
});

/**
 * `TransportMessageSchema` types seq/ack as an unbounded `Type.Integer()` while
 * ProtoCodec's envelope types them as `uint32`. What matters is that the
 * disagreement is loud: a peer that decoded a truncated seq would treat correct
 * traffic as out-of-order.
 */
describe('A8: seq and ack outside the wire format range', () => {
  const outOfRange = gs.oneOf<number>(
    // just past the ceiling, where truncation would be most tempting
    gs.integers({ minValue: 2 ** 32, maxValue: 2 ** 32 + 1_000 }),
    gs.integers({ minValue: 2 ** 33, maxValue: Number.MAX_SAFE_INTEGER }),
    // negative: a valid Type.Integer(), not a valid uint32
    gs.integers({ minValue: -1_000_000, maxValue: -1 }),
  );

  test.each([
    { name: 'naive', codec: NaiveJsonCodec },
    { name: 'binary', codec: BinaryCodec },
  ])('$name carries any safe integer exactly', ({ codec }) =>
    hegel.testAsync((tc) => {
      const seq = tc.draw(outOfRange);
      const ack = tc.draw(outOfRange);
      const msg = { ...tc.draw(transportMessages), seq, ack };

      const decoded = codec.fromBuffer(
        codec.toBuffer(msg),
      ) as OpaqueTransportMessage;

      expect(decoded.seq).toBe(seq);
      expect(decoded.ack).toBe(ack);
    }),
  );

  test('ProtoCodec refuses to encode rather than truncating', () =>
    hegel.testAsync((tc) => {
      const seq = tc.draw(outOfRange);
      const msg = { ...tc.draw(transportMessages), seq };

      // the important half: no bytes carrying a wrapped seq
      expect(() => ProtoCodec.toBuffer(msg)).toThrow(/cannot encode field/);
    }));

  test('a codec that refuses to encode surfaces as a clean send failure', () => {
    // the adapter is what the session talks to; it turns a throwing codec into a
    // Result, so the session is torn down with a reason rather than exploding
    const adapter = new CodecMessageAdapter(ProtoCodec);

    const result = adapter.toBuffer({
      ...messageWithPayload({ type: 'ACK' }),
      seq: 2 ** 32,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.reason).toMatch(/cannot encode field/);
  });
});

/**
 * A1 covers marker escaping across generated payloads. These are the specific
 * cases that used to be broken, plus the compatibility edges that a property
 * over well-formed messages can't reach.
 */
describe('NaiveJsonCodec marker escaping', () => {
  test('a payload key of `$t` survives instead of decoding as binary', () => {
    const msg = { payload: { $t: 'aGVsbG8=' } };

    expect(
      NaiveJsonCodec.fromBuffer(NaiveJsonCodec.toBuffer(msg)),
    ).toStrictEqual(msg);
  });

  test('a payload key of `$b` survives instead of throwing', () => {
    const msg = { payload: { $b: 'not-a-number' } };

    expect(
      NaiveJsonCodec.fromBuffer(NaiveJsonCodec.toBuffer(msg)),
    ).toStrictEqual(msg);
  });

  test('escaping is stable under nesting', () => {
    // a key that is already escape-shaped must not collide with the escaping
    const msg = {
      payload: { $$t: 1, $$$b: 2, $t: { $b: 'x' }, plain: '$t' },
    };

    expect(
      NaiveJsonCodec.fromBuffer(NaiveJsonCodec.toBuffer(msg)),
    ).toStrictEqual(msg);
  });

  test('real binary and bigint values still round-trip', () => {
    const msg = {
      payload: { bin: Uint8Array.from([0, 42, 255]), big: 2n ** 70n },
    };

    expect(
      NaiveJsonCodec.fromBuffer(NaiveJsonCodec.toBuffer(msg)),
    ).toStrictEqual(msg);
  });

  test('a marker written by an older peer still decodes as binary', () => {
    // an unescaped `{ $t: <base64> }` on the wire is what pre-escaping river
    // emitted for a Uint8Array, so it has to keep decoding that way
    const legacy = new TextEncoder().encode(
      JSON.stringify({ payload: { $t: 'aGVsbG8=' } }),
    );

    const decoded = NaiveJsonCodec.fromBuffer(legacy) as { payload: unknown };

    expect(decoded.payload).toBeInstanceOf(Uint8Array);
  });
});

/**
 * Bugs, not endorsements. Pinned so that changing any of them is a visible,
 * intentional act, and so the generators above have something to point at.
 */
describe('documented codec limitations', () => {
  test('msgpack-based codecs encode a `__proto__` payload key but cannot decode it', () => {
    // msgpack guards prototype pollution on decode but not encode, so these
    // produce bytes they then reject -- on the wire, a torn-down connection.
    //
    // Left unfixed deliberately. NaiveJsonCodec could escape its markers for
    // ~1.6% because JSON.stringify's replacer already visits every property;
    // msgpack exposes no equivalent hook and its `__proto__` check runs before
    // `mapKeyConverter`, so the only fix is a second full traversal of every
    // payload on encode -- in the codec chosen for throughput, to defend a key
    // that does not appear in real payloads.
    const msg = messageWithPayload(Object.fromEntries([['__proto__', 'x']]));

    for (const codec of [BinaryCodec, ProtoCodec]) {
      const encoded = codec.toBuffer(msg);
      expect(() => codec.fromBuffer(encoded)).toThrow(
        /__proto__ is not allowed/,
      );
    }

    // the default codec round-trips it fine, so deliverability depends on which
    // codec the transport was configured with
    expect(
      NaiveJsonCodec.fromBuffer(NaiveJsonCodec.toBuffer(msg)),
    ).toStrictEqual(msg);
  });

  test('ProtoCodec decodes an empty serviceName back as absent', () => {
    // the envelope uses '' as the absent sentinel for serviceName/procedureName
    const msg: OpaqueTransportMessage = {
      id: 'id',
      from: 'client',
      to: 'SERVER',
      seq: 0,
      ack: 0,
      streamId: 'stream',
      controlFlags: 0,
      serviceName: '',
      procedureName: '',
      payload: { type: 'ACK' },
    };

    const decoded = ProtoCodec.fromBuffer(ProtoCodec.toBuffer(msg));

    expect(decoded).not.toHaveProperty('serviceName');
    expect(decoded).not.toHaveProperty('procedureName');
  });
});

/** ProtoCodec rejects anything that isn't a full `OpaqueTransportMessage`. */
function messageWithPayload(payload: unknown): OpaqueTransportMessage {
  return {
    id: 'id',
    from: 'client',
    to: 'SERVER',
    seq: 0,
    ack: 0,
    streamId: 'stream',
    controlFlags: 0,
    payload,
  };
}

/** JSON.stringify replacer so tc.note() can print bigint-bearing messages. */
function bigintSafe(_key: string, value: unknown) {
  return typeof value === 'bigint' ? `${value.toString()}n` : value;
}
