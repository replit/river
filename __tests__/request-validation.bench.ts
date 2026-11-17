import { bench, describe, vi } from 'vitest';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';

vi.useRealTimers();

const JsonValue = Type.Cyclic(
  {
    Value: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref('Value')),
      Type.Record(Type.String(), Type.Ref('Value')),
    ]),
  },
  'Value',
);
const schema = Type.Object({ rows: JsonValue });
const validator = Compile(schema);
const input = {
  rows: Array.from({ length: 10000 }, (_, i) => ({
    name: `record ${i}`,
    duration: 1,
    status: 'passed',
    details: 'x'.repeat(128),
  })),
};
const options = {
  time: 500,
  iterations: 3,
  warmupTime: 100,
  warmupIterations: 1,
};

describe('recursive request validation', () => {
  bench('interpreted', () => void Value.Check(schema, input), options);
  bench('compiled and cached', () => void validator.Check(input), options);
});
