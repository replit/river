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
    'transport/impls/uds/client.ts',
    'transport/impls/uds/server.ts',
    'transport/impls/stdio/stdio.ts',
  ],
  format: ['esm', 'cjs'],
  sourcemap: false,
  clean: true,
  dts: true,
  noExternal: ['it-pushable'],
});
