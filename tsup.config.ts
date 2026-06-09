import { defineConfig } from 'tsup';

// Two entries keep tsup's base dir at `src/`, so output preserves the tree:
//   dist/api/server.js  and  dist/workers/inngest/index.js
// `start` (node dist/api/server.js) depends on this not flattening — verified via `ls -R dist`.
export default defineConfig({
  entry: ['src/api/server.ts', 'src/workers/inngest/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
});
