import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeAction, parseTrace, type Trace } from './model';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export const SPEC = path.join(repoRoot, 'spec', 'river.qnt');
export const SPEC_TESTS = path.join(repoRoot, 'spec', 'river_test.qnt');

const QUINT_CLI = path.join(
  repoRoot,
  'node_modules',
  '@informalsystems',
  'quint',
  'dist',
  'src',
  'cli.js',
);

/**
 * The TypeScript simulator needs nothing beyond node_modules; the faster Rust
 * one downloads a binary on first use, so it is opt-in for long local hunts.
 */
const BACKEND = process.env.QUINT_BACKEND ?? 'typescript';

function quint(args: Array<string>) {
  try {
    execFileSync(process.execPath, [QUINT_CLI, ...args, '--backend', BACKEND], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // quint prints the failing scenario or the invariant counterexample
    const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `quint ${args[0]} failed\n${String(stdout ?? '')}${String(stderr ?? '')}`,
    );
  }
}

function readTraces(dir: string, label: string): Array<Trace> {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.itf.json'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((file) =>
      parseTrace(
        `${label} ${file}`,
        readFileSync(path.join(dir, file), 'utf8'),
      ),
    );
}

/** The command line that reruns a quint invocation, printing every state. */
function reproduce(args: Array<string>): string {
  const shown = args.map((arg) =>
    path.isAbsolute(arg) ? path.relative(repoRoot, arg) : arg,
  );

  return `npx quint ${[...shown, '--backend', BACKEND, '--verbosity', '3'].join(
    ' ',
  )}`;
}

/**
 * Runs quint with ITF output in a fresh directory and parses the traces. On
 * failure the directory is kept, and the error names it, lists the steps of
 * the first trace (the counterexample or failing scenario), and gives the
 * command that reproduces the run.
 */
function quintTraces(args: Array<string>, label: string): Array<Trace> {
  const dir = mkdtempSync(path.join(tmpdir(), 'river-quint-'));
  const itf = path.join(
    dir,
    label === 'scenario' ? '{test}_{seq}.itf.json' : 'trace_{seq}.itf.json',
  );
  try {
    quint([...args, '--verbosity', '1', '--out-itf', itf]);
  } catch (err) {
    const lines = [(err as Error).message.trimEnd()];
    try {
      const traces = readTraces(dir, label);
      if (traces.length > 0) {
        const first = traces[0];
        lines.push(
          `steps of ${first.name}:`,
          ...first.steps
            .slice(1)
            .map((step, n) => `  ${n + 1}. ${describeAction(step.action)}`),
        );
      }
    } catch {
      // quint may have stopped before writing a complete trace
    }

    lines.push(`traces kept in ${dir}`, `reproduce: ${reproduce(args)}`);
    throw new Error(lines.join('\n'));
  }

  try {
    return readTraces(dir, label);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Random traces of the model's `step` relation, reproducible from the seed.
 * The same run checks an invariant (`safety` by default) on every state.
 */
export function generateTraces(opts: {
  seed: string;
  count: number;
  maxSteps: number;
  invariant?: string;
}): Array<Trace> {
  return quintTraces(
    [
      'run',
      SPEC,
      '--max-samples',
      String(opts.count),
      '--n-traces',
      String(opts.count),
      '--max-steps',
      String(opts.maxSteps),
      '--seed',
      opts.seed,
      '--invariant',
      opts.invariant ?? 'safety',
    ],
    `seed ${opts.seed}`,
  );
}

/** The fixed scenarios written as `run` definitions in spec/river_test.qnt. */
export function scenarioTraces(match?: string): Array<Trace> {
  return quintTraces(
    [
      'test',
      SPEC_TESTS,
      ...(match ? ['--match', match] : []),
      // scenarios are deterministic apart from the fault generator's seed
      '--max-samples',
      '1',
    ],
    'scenario',
  );
}
