import { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { castTypeboxValueErrors, ValidationErrors } from './errors';

/**
 * Result of parsing an input. This will either hold the result of parsing,
 * which in non-strict may involve modifications on the input, or the errors
 * if the parsing failed.
 */
export type ParseInputResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Static<typeof ValidationErrors> };

/**
 * Options for {@link parseInput}.
 */
export interface ParseInputOptions<T extends TSchema> {
  /**
   * If the schema should be parsed strictly, meaning that the input value
   * is expected to match the schema exactly without any processing. This
   * is the default behavior (`true`).
   *
   * In non-strict mode, the behavior is much closer to protobuf semantics -
   * e.g. new fields are defaulted, unknown enum values are set to their first
   * member, and so on. Input's may still fail to parse, e.g. if they set a
   * known field to the wrong type.
   */
  strict?: boolean;

  /**
   * The schema to parse the input against.
   */
  schema: T;

  /**
   * The input value to parse.
   */
  input: unknown;
}

/**
 * Parse an input against a schema. This is intended for non-control, client
 * provided input. This yields a {@link ParseInputResult} which will either
 * hold the result of parsing, which in non-strict may involve modifications on
 * the input, or the errors if the parsing failed.
 *
 * @see {@link ParseInputOptions}
 */
export function parseInput<T extends TSchema>({
  strict,
  schema,
  input,
}: ParseInputOptions<T>): ParseInputResult<Static<T>> {
  // default path, we just check the value against the schema
  if (strict) {
    return Value.Check(schema, input)
      ? { ok: true, value: input }
      : {
          ok: false,
          errors: castTypeboxValueErrors(Value.Errors(schema, input)),
        };
  }

  let parsed = input;

  try {
    // TODO: switch to Value.Parse when we have it
    // parsed = Value.Parse(['Clone', 'Clean', 'Default', 'Decode'], value);
    parsed = Value.Clone(parsed);
    parsed = Value.Clean(schema, parsed);
    parsed = Value.Default(schema, parsed);
    // skipped: Value.Convert(schema, parsed);
    // unavailable: Value.Assert(schema, parsed);
    parsed = Value.Decode(schema, parsed);
  } catch {
    return {
      ok: false,
      // we intentionally get the errors for the parsed value we currently have,
      // as that signifies the point in parsing in which we failed to continue
      // cleaning up the input.
      errors: castTypeboxValueErrors(Value.Errors(schema, parsed)),
    };
  }

  return { ok: true, value: parsed };
}
