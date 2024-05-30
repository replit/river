import { defineConfig } from 'vite';
import { configDefaults, coverageConfigDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./util/testHelpers.ts'],
    exclude: [...configDefaults.exclude, '**/.direnv/**'],
    coverage: {
      exclude: [...coverageConfigDefaults.exclude, '**/.direnv/**'],
    },
  },
});
