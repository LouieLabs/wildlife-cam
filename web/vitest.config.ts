import { defineConfig } from 'vitest/config';
import path from 'path';

// Vitest is wired only for the small server-side unit tests under `test/`.
// We don't run any browser/jsdom suites here; everything is plain Node.
//
// The "@" alias mirrors tsconfig.json so test files can import production code
// the same way the routes do (e.g. `@/lib/rateLimit`).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,   // import { describe, it, expect } explicitly — clearer
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
