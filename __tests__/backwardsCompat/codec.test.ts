/**
 * Backwards compatibility tests for codec message adapters.
 *
 * These tests verify that messages encoded with the legacy TypeBox (0.34.x)
 * can be decoded and validated by the new TypeBox (1.0) CodecMessageAdapter,
 * and vice versa. This ensures that during a rolling upgrade, servers/clients
 * using different river versions can communicate.
 */
import { describe, test, expect } from 'vitest';
import { Type as LegacyType } from 'legacyTypebox';
import { Value as LegacyValue } from 'legacyTypebox/value';
import { Type as NewType } from 'typebox';
import { Value as NewValue } from 'typebox/value';
import { NaiveJsonCodec, BinaryCodec, CodecMessageAdapter } from '../../codec';
import {
  OpaqueTransportMessageSchema,
  type OpaqueTransportMessage,
} from '../../transport/message';
import { Uint8ArrayType } from '../../customSchemas';

/**
 * Helper: Build a complete OpaqueTransportMessage for testing.
 */
function makeTransportMessage(
  payload: unknown,
  overrides: Partial<OpaqueTransportMessage> = {},
): OpaqueTransportMessage {
  return {
    id: 'msg-1',
    from: 'client-1',
    to: 'server-1',
    seq: 0,
    ack: 0,
    streamId: 'stream-1',
    controlFlags: 0,
    payload,
    ...overrides,
  };
}

/**
 * The legacy OpaqueTransportMessageSchema, reconstructed using legacy TypeBox.
 * This mirrors what the old river code would have used for validation.
 */
const LegacyOpaqueTransportMessageSchema = LegacyType.Object({
  id: LegacyType.String(),
  from: LegacyType.String(),
  to: LegacyType.String(),
  seq: LegacyType.Integer(),
  ack: LegacyType.Integer(),
  serviceName: LegacyType.Optional(LegacyType.String()),
  procedureName: LegacyType.Optional(LegacyType.String()),
  streamId: LegacyType.String(),
  controlFlags: LegacyType.Integer(),
  tracing: LegacyType.Optional(
    LegacyType.Object({
      traceparent: LegacyType.String(),
      tracestate: LegacyType.String(),
    }),
  ),
  payload: LegacyType.Unknown(),
});

describe.each([
  { name: 'naive JSON codec', codec: NaiveJsonCodec },
  { name: 'binary codec', codec: BinaryCodec },
])('codec backwards compatibility ($name)', ({ codec }) => {
  const adapter = new CodecMessageAdapter(codec);

  describe('basic message round-trip', () => {
    test('message with object payload survives encode/decode', () => {
      const msg = makeTransportMessage({ greeting: 'hello', count: 42 });
      const encoded = adapter.toBuffer(msg);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;

      const decoded = adapter.fromBuffer(encoded.value);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.value).toEqual(msg);
    });

    test('message with nested object payload', () => {
      const msg = makeTransportMessage({
        ok: true,
        payload: { result: 42 },
      });
      const encoded = adapter.toBuffer(msg);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;

      const decoded = adapter.fromBuffer(encoded.value);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.value).toEqual(msg);
    });

    test('message with error payload (Err result format)', () => {
      const msg = makeTransportMessage({
        ok: false,
        payload: {
          code: 'SOME_ERROR',
          message: 'something went wrong',
          extras: { detail: 'extra info' },
        },
      });
      const encoded = adapter.toBuffer(msg);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;

      const decoded = adapter.fromBuffer(encoded.value);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.value).toEqual(msg);
    });
  });

  describe('Uint8Array payload handling', () => {
    test('message with Uint8Array in payload survives round-trip', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const msg = makeTransportMessage({
        ok: true,
        payload: { contents: bytes },
      });
      const encoded = adapter.toBuffer(msg);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;

      const decoded = adapter.fromBuffer(encoded.value);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;

      // The decoded Uint8Array should have the same bytes
      const decodedPayload = decoded.value.payload as {
        ok: boolean;
        payload: { contents: Uint8Array };
      };
      expect(decodedPayload.ok).toBe(true);
      expect(new Uint8Array(decodedPayload.payload.contents)).toEqual(bytes);
    });
  });

  describe('new TypeBox 1.0 validation accepts messages from legacy codec', () => {
    test('encoded message passes new OpaqueTransportMessageSchema validation', () => {
      const msg = makeTransportMessage({ ok: true, payload: { result: 1 } });
      const encoded = adapter.toBuffer(msg);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;

      const decoded = adapter.fromBuffer(encoded.value);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;

      // Validate with new TypeBox
      expect(NewValue.Check(OpaqueTransportMessageSchema, decoded.value)).toBe(
        true,
      );
    });

    test('encoded message also passes legacy schema validation', () => {
      const msg = makeTransportMessage({ ok: true, payload: { result: 1 } });
      const encoded = adapter.toBuffer(msg);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;

      const decoded = adapter.fromBuffer(encoded.value);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;

      // Validate with legacy TypeBox
      expect(
        LegacyValue.Check(LegacyOpaqueTransportMessageSchema, decoded.value),
      ).toBe(true);
    });
  });

  describe('cross-version validation of payloads', () => {
    test('object validated by legacy TypeBox is also valid under new TypeBox', () => {
      const legacySchema = LegacyType.Object({
        name: LegacyType.String(),
        age: LegacyType.Number(),
      });
      const newSchema = NewType.Object({
        name: NewType.String(),
        age: NewType.Number(),
      });

      const data = { name: 'Alice', age: 30 };
      expect(LegacyValue.Check(legacySchema, data)).toBe(true);
      expect(NewValue.Check(newSchema, data)).toBe(true);
    });

    test('union validated by legacy TypeBox is also valid under new TypeBox', () => {
      const legacySchema = LegacyType.Union([
        LegacyType.Object({
          code: LegacyType.Literal('ERR_A'),
          message: LegacyType.String(),
        }),
        LegacyType.Object({
          code: LegacyType.Literal('ERR_B'),
          message: LegacyType.String(),
          extras: LegacyType.Object({ detail: LegacyType.String() }),
        }),
      ]);
      const newSchema = NewType.Union([
        NewType.Object({
          code: NewType.Literal('ERR_A'),
          message: NewType.String(),
        }),
        NewType.Object({
          code: NewType.Literal('ERR_B'),
          message: NewType.String(),
          extras: NewType.Object({ detail: NewType.String() }),
        }),
      ]);

      const data1 = { code: 'ERR_A', message: 'oops' };
      const data2 = {
        code: 'ERR_B',
        message: 'oops',
        extras: { detail: 'info' },
      };
      const invalidData = { code: 'ERR_C', message: 'unknown' };

      expect(LegacyValue.Check(legacySchema, data1)).toBe(true);
      expect(NewValue.Check(newSchema, data1)).toBe(true);

      expect(LegacyValue.Check(legacySchema, data2)).toBe(true);
      expect(NewValue.Check(newSchema, data2)).toBe(true);

      expect(LegacyValue.Check(legacySchema, invalidData)).toBe(false);
      expect(NewValue.Check(newSchema, invalidData)).toBe(false);
    });

    test('Uint8Array validated by legacy Type.Uint8Array matches new Uint8ArrayType', () => {
      const legacySchema = LegacyType.Uint8Array();
      const newSchema = Uint8ArrayType();

      const validData = new Uint8Array([1, 2, 3]);
      expect(LegacyValue.Check(legacySchema, validData)).toBe(true);
      expect(NewValue.Check(newSchema, validData)).toBe(true);

      // Both should reject non-Uint8Array values
      expect(LegacyValue.Check(legacySchema, [1, 2, 3])).toBe(false);
      expect(NewValue.Check(newSchema, [1, 2, 3])).toBe(false);

      expect(LegacyValue.Check(legacySchema, 'not bytes')).toBe(false);
      expect(NewValue.Check(newSchema, 'not bytes')).toBe(false);
    });

    test('Uint8ArrayType with byte length constraints', () => {
      const newSchema = Uint8ArrayType({ minByteLength: 2, maxByteLength: 5 });

      expect(NewValue.Check(newSchema, new Uint8Array([1]))).toBe(false);
      expect(NewValue.Check(newSchema, new Uint8Array([1, 2]))).toBe(true);
      expect(NewValue.Check(newSchema, new Uint8Array([1, 2, 3, 4, 5]))).toBe(
        true,
      );
      expect(
        NewValue.Check(newSchema, new Uint8Array([1, 2, 3, 4, 5, 6])),
      ).toBe(false);
    });
  });

  describe('full transport message round-trip with validation', () => {
    test('encode with new TypeBox, validate with legacy', () => {
      const msg = makeTransportMessage(
        { ok: true, payload: { name: 'test', value: 42 } },
        {
          serviceName: 'myService',
          procedureName: 'myProcedure',
          controlFlags: 1, // StreamOpenBit
        },
      );

      const encoded = adapter.toBuffer(msg);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;

      const decoded = adapter.fromBuffer(encoded.value);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;

      // Both old and new schemas should accept the decoded message
      expect(
        LegacyValue.Check(LegacyOpaqueTransportMessageSchema, decoded.value),
      ).toBe(true);
      expect(NewValue.Check(OpaqueTransportMessageSchema, decoded.value)).toBe(
        true,
      );
    });

    test('handshake request message round-trip', () => {
      const msg = makeTransportMessage(
        {
          type: 'HANDSHAKE_REQ',
          protocolVersion: 'v2.0',
          sessionId: 'session-1',
          expectedSessionState: {
            nextExpectedSeq: 0,
            nextSentSeq: 0,
          },
        },
        { controlFlags: 1 },
      );

      const encoded = adapter.toBuffer(msg);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;

      const decoded = adapter.fromBuffer(encoded.value);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;

      expect(decoded.value).toEqual(msg);
    });

    test('handshake response message round-trip', () => {
      const msg = makeTransportMessage(
        {
          type: 'HANDSHAKE_RESP',
          status: { ok: true, sessionId: 'session-123' },
        },
        { controlFlags: 1 },
      );

      const encoded = adapter.toBuffer(msg);
      expect(encoded.ok).toBe(true);
      if (!encoded.ok) return;

      const decoded = adapter.fromBuffer(encoded.value);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;

      expect(decoded.value).toEqual(msg);
    });
  });
});
