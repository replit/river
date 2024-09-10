import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'router/index.ts',
    'logging/index.ts',
    'codec/index.ts',
    'testUtil/index.ts',
    'transport/index.ts',
    'transport/impls/ws/client.ts',
    'transport/impls/ws/server.ts',
    'transport/impls/uds/client.ts',
    'transport/impls/uds/server.ts',
  ],
  format: ['esm', 'cjs'],
  sourcemap: true,
  clean: true,
  dts: true,
});
