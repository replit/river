/**
 * Backwards compatibility tests for schema serialization.
 *
 * These tests verify that schemas defined with typebox 1.0 serialize to the
 * same JSON Schema output as schemas defined with @sinclair/typebox 0.34.x.
 * This is critical because serialized schemas are shared across the wire
 * between clients and servers that may be running different versions of river.
 */
import { describe, test, expect } from 'vitest';
import { Type as LegacyType } from 'legacyTypebox';
import { Type as NewType } from 'typebox';
import { Uint8ArrayType } from '../../customSchemas';

/**
 * Strips internal TypeBox symbols by JSON roundtripping, matching what
 * river's `Strict()` function does during serialization.
 */
function strip(schema: object): unknown {
  return JSON.parse(JSON.stringify(schema));
}

describe('schema serialization backwards compatibility', () => {
  describe('primitive types', () => {
    test('Type.String()', () => {
      expect(strip(NewType.String())).toEqual(strip(LegacyType.String()));
    });

    test('Type.Number()', () => {
      expect(strip(NewType.Number())).toEqual(strip(LegacyType.Number()));
    });

    test('Type.Integer()', () => {
      expect(strip(NewType.Integer())).toEqual(strip(LegacyType.Integer()));
    });

    test('Type.Boolean()', () => {
      expect(strip(NewType.Boolean())).toEqual(strip(LegacyType.Boolean()));
    });

    test('Type.Null()', () => {
      expect(strip(NewType.Null())).toEqual(strip(LegacyType.Null()));
    });

    test('Type.Unknown()', () => {
      expect(strip(NewType.Unknown())).toEqual(strip(LegacyType.Unknown()));
    });
  });

  describe('literal types', () => {
    test('Type.Literal(string)', () => {
      expect(strip(NewType.Literal('hello'))).toEqual(
        strip(LegacyType.Literal('hello')),
      );
    });

    test('Type.Literal(number)', () => {
      expect(strip(NewType.Literal(42))).toEqual(strip(LegacyType.Literal(42)));
    });

    test('Type.Literal(boolean)', () => {
      expect(strip(NewType.Literal(true))).toEqual(
        strip(LegacyType.Literal(true)),
      );
    });
  });

  describe('composite types', () => {
    test('Type.Object with required properties', () => {
      const legacy = LegacyType.Object({
        name: LegacyType.String(),
        age: LegacyType.Number(),
      });
      const current = NewType.Object({
        name: NewType.String(),
        age: NewType.Number(),
      });
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('Type.Object with optional properties', () => {
      const legacy = LegacyType.Object({
        name: LegacyType.String(),
        nickname: LegacyType.Optional(LegacyType.String()),
      });
      const current = NewType.Object({
        name: NewType.String(),
        nickname: NewType.Optional(NewType.String()),
      });
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('Type.Object with description', () => {
      const legacy = LegacyType.Object(
        { a: LegacyType.Number() },
        { description: 'test object' },
      );
      const current = NewType.Object(
        { a: NewType.Number() },
        { description: 'test object' },
      );
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('Type.Array of primitives', () => {
      const legacy = LegacyType.Array(LegacyType.String());
      const current = NewType.Array(NewType.String());
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('Type.Array of objects', () => {
      const legacy = LegacyType.Array(
        LegacyType.Object({ id: LegacyType.Number() }),
      );
      const current = NewType.Array(NewType.Object({ id: NewType.Number() }));
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('Type.Union of objects', () => {
      const legacy = LegacyType.Union([
        LegacyType.Object({ code: LegacyType.Literal('A') }),
        LegacyType.Object({ code: LegacyType.Literal('B') }),
      ]);
      const current = NewType.Union([
        NewType.Object({ code: NewType.Literal('A') }),
        NewType.Object({ code: NewType.Literal('B') }),
      ]);
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('Type.Union of literals', () => {
      const legacy = LegacyType.Union([
        LegacyType.Literal('a'),
        LegacyType.Literal('b'),
        LegacyType.Literal('c'),
      ]);
      const current = NewType.Union([
        NewType.Literal('a'),
        NewType.Literal('b'),
        NewType.Literal('c'),
      ]);
      expect(strip(current)).toEqual(strip(legacy));
    });
  });

  describe('Uint8Array custom type', () => {
    test('Uint8ArrayType() matches legacy Type.Uint8Array() serialization', () => {
      const legacy = LegacyType.Uint8Array();
      const current = Uint8ArrayType();
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('Uint8ArrayType with minByteLength matches legacy', () => {
      const legacy = LegacyType.Uint8Array({ minByteLength: 1 });
      const current = Uint8ArrayType({ minByteLength: 1 });
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('Uint8ArrayType with maxByteLength matches legacy', () => {
      const legacy = LegacyType.Uint8Array({ maxByteLength: 1024 });
      const current = Uint8ArrayType({ maxByteLength: 1024 });
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('Uint8ArrayType with both constraints matches legacy', () => {
      const legacy = LegacyType.Uint8Array({
        minByteLength: 1,
        maxByteLength: 1024,
      });
      const current = Uint8ArrayType({
        minByteLength: 1,
        maxByteLength: 1024,
      });
      expect(strip(current)).toEqual(strip(legacy));
    });
  });

  describe('river-specific schema patterns', () => {
    test('transport message schema shape', () => {
      const legacy = LegacyType.Object({
        id: LegacyType.String(),
        from: LegacyType.String(),
        to: LegacyType.String(),
        seq: LegacyType.Integer(),
        ack: LegacyType.Integer(),
        serviceName: LegacyType.Optional(LegacyType.String()),
        procedureName: LegacyType.Optional(LegacyType.String()),
        streamId: LegacyType.String(),
        controlFlags: LegacyType.Integer(),
        payload: LegacyType.Unknown(),
      });
      const current = NewType.Object({
        id: NewType.String(),
        from: NewType.String(),
        to: NewType.String(),
        seq: NewType.Integer(),
        ack: NewType.Integer(),
        serviceName: NewType.Optional(NewType.String()),
        procedureName: NewType.Optional(NewType.String()),
        streamId: NewType.String(),
        controlFlags: NewType.Integer(),
        payload: NewType.Unknown(),
      });
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('result schema shape (Ok/Err)', () => {
      const legacy = LegacyType.Union([
        LegacyType.Object({
          ok: LegacyType.Literal(false),
          payload: LegacyType.Object({
            code: LegacyType.String(),
            message: LegacyType.String(),
            extras: LegacyType.Optional(LegacyType.Unknown()),
          }),
        }),
        LegacyType.Object({
          ok: LegacyType.Literal(true),
          payload: LegacyType.Unknown(),
        }),
      ]);
      const current = NewType.Union([
        NewType.Object({
          ok: NewType.Literal(false),
          payload: NewType.Object({
            code: NewType.String(),
            message: NewType.String(),
            extras: NewType.Optional(NewType.Unknown()),
          }),
        }),
        NewType.Object({
          ok: NewType.Literal(true),
          payload: NewType.Unknown(),
        }),
      ]);
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('error schema with code literal and extras', () => {
      const legacy = LegacyType.Object({
        code: LegacyType.Literal('SOME_ERROR'),
        message: LegacyType.String(),
        extras: LegacyType.Object({ detail: LegacyType.String() }),
      });
      const current = NewType.Object({
        code: NewType.Literal('SOME_ERROR'),
        message: NewType.String(),
        extras: NewType.Object({ detail: NewType.String() }),
      });
      expect(strip(current)).toEqual(strip(legacy));
    });

    test('service schema with Uint8Array field', () => {
      const legacy = LegacyType.Object({
        file: LegacyType.String(),
        contents: LegacyType.Uint8Array(),
      });
      const current = NewType.Object({
        file: NewType.String(),
        contents: Uint8ArrayType(),
      });
      expect(strip(current)).toEqual(strip(legacy));
    });
  });
});
