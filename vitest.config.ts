import { defineConfig } from 'vite';
import { configDefaults, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // .claude holds scratch git worktrees: stale checkouts of this same repo
    exclude: [...configDefaults.exclude, '**/.direnv/**', '**/.claude/**'],
    coverage: {
      exclude: [
        ...coverageConfigDefaults.exclude,
        '**/.direnv/**',
        '**/.claude/**',
      ],
    },
    sequence: {
      hooks: 'stack',
    },
    reporters: process.env.GITHUB_ACTIONS
      ? ['basic', 'github-actions', 'junit']
      : ['default'],
    pool: 'forks',
    testTimeout: 1000,
    setupFiles: './__tests__/globalSetup.ts',
  },
});
