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
    pool: 'forks',
  },
});
