import { vi } from 'vitest';
import FakeTimers from '@sinonjs/fake-timers';
import type { Codec } from '../../codec/types';
import { Harness } from './harness';
import {
  describeAction,
  projectModel,
  type QAction,
  type QState,
  type Trace,
} from './model';
import { diff, maskUnobservable, type Difference } from './projection';

/**
 * A divergence the model has already found and the implementation still has.
 * Replay stops just before the triggering action, so the remaining traces keep
 * checking everything else until the bug is fixed and its entry removed.
 */
export interface KnownBug {
  id: string;
  summary: string;
  /** The spec/river_test.qnt run that reproduces it. */
  scenario: string;
  matches: (before: QState, action: QAction) => boolean;
}

export type Outcome =
  | { kind: 'ok'; steps: number }
  | { kind: 'known-bug'; bug: KnownBug; step: number }
  | {
      kind: 'diverged';
      step: number;
      action: string;
      differences: Array<Difference>;
      history: Array<string>;
    }
  | {
      kind: 'error';
      step: number;
      action: string;
      error: unknown;
      history: Array<string>;
    };

/**
 * Replays a model trace against the implementation, comparing the two
 * projections after the initial state and after every action.
 */
export async function replay(
  trace: Trace,
  knownBugs: ReadonlyArray<KnownBug> = [],
  codec?: Codec,
): Promise<Outcome> {
  // a clock of our own rather than vitest's: its next() fires exactly one timer
  vi.useRealTimers();
  const clock = FakeTimers.install({
    now: 0,
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
    ],
  });

  const rejections: Array<unknown> = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);

  const harness = new Harness(trace.steps[0].st.cfg, clock, codec);
  const history: Array<string> = [];
  try {
    for (const [i, { st, action }] of trace.steps.entries()) {
      const described = describeAction(action);
      if (i > 0) {
        const before = trace.steps[i - 1].st;
        const bug = knownBugs.find((b) => b.matches(before, action));
        if (bug) return { kind: 'known-bug', bug, step: i };

        history.push(described);
        try {
          await harness.apply(action);
        } catch (error) {
          return { kind: 'error', step: i, action: described, error, history };
        }

        if (rejections.length > 0) {
          return {
            kind: 'error',
            step: i,
            action: described,
            error: rejections[0],
            history,
          };
        }
      }

      const model = projectModel(st);
      const impl = harness.project(st);
      maskUnobservable(model, impl);
      const differences = diff(model, impl);
      if (differences.length > 0) {
        return {
          kind: 'diverged',
          step: i,
          action: described,
          differences,
          history,
        };
      }
    }

    return { kind: 'ok', steps: trace.steps.length };
  } finally {
    harness.dispose();
    process.off('unhandledRejection', onRejection);
    clock.uninstall();
  }
}

export function formatOutcome(trace: Trace, outcome: Outcome): string {
  switch (outcome.kind) {
    case 'ok':
      return `${trace.name}: ok (${outcome.steps} states)`;
    case 'known-bug':
      return `${trace.name}: stopped at step ${outcome.step} on known bug ${outcome.bug.id}`;
    case 'error':
      return [
        `${trace.name}: implementation threw at step ${outcome.step} (${outcome.action})`,
        `  ${String(
          outcome.error instanceof Error ? outcome.error.stack : outcome.error,
        )}`,
        '  actions:',
        ...outcome.history.map((a, i) => `    ${i + 1}. ${a}`),
      ].join('\n');
    case 'diverged':
      return [
        `${trace.name}: diverged from the model at step ${outcome.step} (${outcome.action})`,
        ...outcome.differences
          .slice(0, 25)
          .map(
            (d) =>
              `  ${d.path}\n    model: ${JSON.stringify(
                d.model,
              )}\n    impl:  ${JSON.stringify(d.impl)}`,
          ),
        '  actions:',
        ...outcome.history.map((a, i) => `    ${i + 1}. ${a}`),
      ].join('\n');
  }
}
