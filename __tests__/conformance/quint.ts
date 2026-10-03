import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrace, type Trace } from './model';

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

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'river-quint-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Random traces of the model's `step` relation, reproducible from the seed.
 * The same run checks the model's `safety` invariant on every state it visits.
 */
export function generateTraces(opts: {
  seed: string;
  count: number;
  maxSteps: number;
}): Array<Trace> {
  return withTempDir((dir) => {
    quint([
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
      'safety',
      '--verbosity',
      '1',
      '--out-itf',
      path.join(dir, 'trace_{seq}.itf.json'),
    ]);

    return readTraces(dir, `seed ${opts.seed}`);
  });
}

/** The fixed scenarios written as `run` definitions in spec/river_test.qnt. */
export function scenarioTraces(match?: string): Array<Trace> {
  return withTempDir((dir) => {
    quint([
      'test',
      SPEC_TESTS,
      ...(match ? ['--match', match] : []),
      // scenarios are deterministic apart from the fault generator's seed
      '--max-samples',
      '1',
      '--verbosity',
      '0',
      '--out-itf',
      path.join(dir, '{test}_{seq}.itf.json'),
    ]);

    return readTraces(dir, 'scenario');
  });
}
