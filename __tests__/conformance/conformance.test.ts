import { beforeAll, describe, expect, test } from 'vitest';
import { BinaryCodec, NaiveJsonCodec, type Codec } from '../../codec';
import { ProtoCodec } from '../../protobuf/codec';
import { some, type QState, type Trace } from './model';
import { generateTraces, scenarioTraces } from './quint';
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

function clientHandshakingOn(st: QState, conn: number): boolean {
  const cs = some(st.client.session);

  return cs?.st.tag === 'CHandshaking' && cs.st.value === conn;
}

/**
 * Divergences the model has found that are not fixed yet. Random traces stop
 * just before a known bug's trigger; once a bug is fixed, its scenario stops
 * reproducing and the entry has to go.
 */
const KNOWN_BUGS: Array<KnownBug> = [
  {
    id: 'invalid-handshake-response',
    summary:
      'An undecodable handshake response makes ClientTransport throw from the connection data listener (deleteSession reads the consumed Connecting state) instead of tearing the session down',
    scenario: 'invalidHandshakeResponseTest',
    matches: (before, action) =>
      action.tag === 'AGarbage' &&
      !action.value.server &&
      clientHandshakingOn(before, action.value.conn),
  },
  {
    id: 'server-close-keeps-pending-handshakes',
    summary:
      'ServerTransport.close() leaves connections that are still handshaking open; a handshake that completes afterwards creates a session on the closed transport that heartbeats forever while every message is dropped',
    scenario: 'serverCloseDuringHandshakeTest',
    matches: (before, action) =>
      action.tag === 'AServerClose' && before.server.pending.size > 0,
  },
];

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
let randomTraces: Array<Trace> = [];
beforeAll(() => {
  scenarios = scenarioTraces();
  randomTraces = generateTraces({
    seed: SEED,
    count: TRACES,
    maxSteps: STEPS,
  });
}, 120_000);

describe.each(CODECS)(
  'the implementation conforms to spec/river.qnt over the $name codec',
  ({ codec }) => {
    test('every scenario in spec/river_test.qnt replays identically', async () => {
      expect(scenarios.length).toBeGreaterThan(0);
      expect((await failuresOf(scenarios, codec)).join('\n\n')).toBe('');
    }, 60_000);

    test.each(KNOWN_BUGS)('known bug $id still reproduces', async (bug) => {
      const trace = scenarios.find((t) => t.name.includes(`${bug.scenario}_`));
      if (!trace) throw new Error(`no scenario named ${bug.scenario}`);

      const outcome = await replay(trace, [], codec);
      expect(
        outcome.kind === 'diverged' || outcome.kind === 'error',
        `${bug.id} no longer reproduces: remove it from KNOWN_BUGS`,
      ).toBe(true);
    });

    test(`${TRACES} random traces (seed ${SEED}) replay identically`, async () => {
      const tally: Record<string, number> = {};
      const failures = await failuresOf(randomTraces, codec, tally);
      if (process.env.QUINT_VERBOSE) console.log(tally);

      expect(failures.join('\n\n')).toBe('');
    }, 300_000);
  },
);
