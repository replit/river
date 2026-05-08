import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'router/index.ts',
    'protobuf/index.ts',
    'protobuf/codec.ts',
    'logging/index.ts',
    'codec/index.ts',
    'testUtil/index.ts',
    'customSchemas/index.ts',
    'transport/index.ts',
    'transport/impls/ws/client.ts',
    'transport/impls/ws/server.ts',
    'transport/impls/uds/client.ts',
    'transport/impls/uds/server.ts',
  ],
  format: ['esm'],
  sourcemap: true,
  clean: true,
  dts: true,
});
