import { Type } from 'typebox';

/**
 * Creates a TypeBox schema for `Uint8Array` values with optional byte length constraints.
 * This replaces the removed `Type.Uint8Array()` from TypeBox 0.34.x.
 *
 * The schema serializes with `{ type: 'Uint8Array' }` for backwards compatibility
 * with older River clients/servers that used the built-in `Type.Uint8Array()`.
 *
 * @param options - Optional constraints for minimum and maximum byte length.
 * @returns A TypeBox schema that validates `Uint8Array` instances.
 */
export function Uint8ArrayType(
  options: {
    minByteLength?: number;
    maxByteLength?: number;
  } = {},
) {
  return Type.Refine(
    Type.Unsafe<Uint8Array>({
      type: 'Uint8Array',
      ...options,
    }),
    (value): value is Uint8Array => {
      if (!(value instanceof Uint8Array)) return false;
      if (
        typeof options.minByteLength === 'number' &&
        value.byteLength < options.minByteLength
      )
        return false;
      if (
        typeof options.maxByteLength === 'number' &&
        value.byteLength > options.maxByteLength
      )
        return false;

      return true;
    },
  );
}

/**
 * Creates a TypeBox schema for `Date` values.
 * This replaces the removed `Type.Date()` from TypeBox 0.34.x.
 *
 * The schema serializes with `{ type: 'Date' }` for backwards compatibility
 * with older River clients/servers that used the built-in `Type.Date()`.
 *
 * @param options - Optional constraints for minimum and maximum date values.
 * @returns A TypeBox schema that validates `Date` instances (rejects invalid dates).
 */
export function DateType(
  options: {
    minimumTimestamp?: number;
    maximumTimestamp?: number;
  } = {},
) {
  return Type.Refine(
    Type.Unsafe<Date>({
      type: 'Date',
      ...options,
    }),
    (value): value is Date => {
      if (!(value instanceof Date)) return false;
      if (isNaN(value.getTime())) return false;
      if (
        typeof options.minimumTimestamp === 'number' &&
        value.getTime() < options.minimumTimestamp
      )
        return false;
      if (
        typeof options.maximumTimestamp === 'number' &&
        value.getTime() > options.maximumTimestamp
      )
        return false;

      return true;
    },
  );
}
