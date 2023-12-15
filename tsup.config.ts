import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'router/index.ts',
    'logging/index.ts',
    'codec/index.ts',
    'util/testHelpers.ts',
    'transport/index.ts',
    'transport/impls/ws/client.ts',
    'transport/impls/ws/server.ts',
    'transport/stdio.ts',
  ],
  format: ['esm', 'cjs'],
  sourcemap: false,
  clean: true,
  dts: true,
});
