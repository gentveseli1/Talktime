import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
  resolve: {
    alias: {
      // libsodium-wrappers 0.7.16 ships a broken ESM build whose internal
      // `./libsodium.mjs` import does not resolve under Rollup. Force the
      // working CJS build via an absolute file alias (an absolute path
      // bypasses the package's `exports` subpath restriction).
      'libsodium-wrappers': path.resolve(
        here,
        'node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js',
      ),
    },
  },
});
