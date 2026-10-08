import { beforeAll, describe, expect, test } from 'vitest';
import { BinaryCodec, NaiveJsonCodec, type Codec } from '../../codec';
import { ProtoCodec } from '../../protobuf/codec';
import type { Trace } from './model';
import { scenarioTraces, traceBatches } from './quint';
import { formatOutcome, replay, type KnownBug } from './replay';

/**
 * Replays traces of spec/river.qnt against the real transports, router, and
 * client over each codec, failing on the first step where the two disagree.
 * See spec/README.md.
 *
 *   QUINT_SEED      seed for the random traces (default 0x5eed); `random`
 *                   picks a fresh one, shown in the test name
 *   QUINT_TRACES    how many random traces (default 100)
 *   QUINT_STEPS     steps per random trace (default 60)
 *   QUINT_BACKEND   typescript (default) or rust, for long local runs
 *   QUINT_VERBOSE   print how each random trace ended
 */
const SEED =
  process.env.QUINT_SEED === 'random'
    ? `0x${Math.floor(Math.random() * 2 ** 32).toString(16)}`
    : process.env.QUINT_SEED ?? '0x5eed';
const TRACES = Number(process.env.QUINT_TRACES ?? '100');
const STEPS = Number(process.env.QUINT_STEPS ?? '60');

/**
 * Divergences the model has found that are not fixed yet. Random traces stop
 * just before a known bug's trigger; once a bug is fixed, its scenario stops
 * reproducing and the entry has to go.
 */
const KNOWN_BUGS: Array<KnownBug> = [];

/** Every trace is replayed over each codec the transports can use. */
const CODECS: Array<{ name: string; codec: Codec }> = [
  { name: 'json', codec: NaiveJsonCodec },
  { name: 'binary', codec: BinaryCodec },
  { name: 'proto', codec: ProtoCodec },
];

async function failuresOf(
  traces: Array<Trace>,
  codec: Codec,
  tally?: Record<string, number>,
): Promise<Array<string>> {
  const failures: Array<string> = [];
  for (const trace of traces) {
    const outcome = await replay(trace, KNOWN_BUGS, codec);
    if (tally) {
      const key = outcome.kind === 'known-bug' ? outcome.bug.id : outcome.kind;
      tally[key] = (tally[key] ?? 0) + 1;
    }

    if (outcome.kind === 'diverged' || outcome.kind === 'error') {
      failures.push(formatOutcome(trace, outcome));
      if (failures.length >= 3) break;
    }
  }

  return failures;
}

let scenarios: Array<Trace> = [];
beforeAll(() => {
  scenarios = scenarioTraces();
}, 120_000);

describe.each(CODECS)(
  'the implementation conforms to spec/river.qnt over the $name codec',
  ({ codec }) => {
    test('every scenario in spec/river_test.qnt replays identically', async () => {
      expect(scenarios.length).toBeGreaterThan(0);
      expect((await failuresOf(scenarios, codec)).join('\n\n')).toBe('');
    }, 60_000);

    if (KNOWN_BUGS.length > 0) {
      test.each(KNOWN_BUGS)('known bug $id still reproduces', async (bug) => {
        const trace = scenarios.find((t) =>
          t.name.includes(`${bug.scenario}_`),
        );
        if (!trace) throw new Error(`no scenario named ${bug.scenario}`);

        const outcome = await replay(trace, [], codec);
        expect(
          outcome.kind === 'diverged' || outcome.kind === 'error',
          `${bug.id} no longer reproduces: remove it from KNOWN_BUGS`,
        ).toBe(true);
      });
    }
  },
);

test(`${TRACES} random traces (seed ${SEED}) replay identically over every codec`, async () => {
  const failures: Array<string> = [];
  const tallies = new Map(
    CODECS.map(({ name }) => [name, {} as Record<string, number>]),
  );
  for (const batch of traceBatches({
    seed: SEED,
    count: TRACES,
    maxSteps: STEPS,
  })) {
    for (const { name, codec } of CODECS) {
      const found = await failuresOf(batch, codec, tallies.get(name));
      failures.push(...found.map((failure) => `[${name} codec] ${failure}`));
    }

    if (failures.length > 0) break;
  }

  if (process.env.QUINT_VERBOSE) console.log(Object.fromEntries(tallies));
  expect(failures.slice(0, 3).join('\n\n')).toBe('');
}, 1_800_000);
