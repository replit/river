import { defineConfig } from 'vite';
import { configDefaults, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.direnv/**'],
    coverage: {
      exclude: [...coverageConfigDefaults.exclude, '**/.direnv/**'],
    },
    sequence: {
      hooks: 'stack',
    },
    reporters: process.env.GITHUB_ACTIONS
      ? ['basic', 'github-actions', 'junit']
      : ['default'],
    outputFile: 'test-results.xml',
    pool: 'forks',
    testTimeout: 1000,
    setupFiles: './__tests__/globalSetup.ts',
  },
});
