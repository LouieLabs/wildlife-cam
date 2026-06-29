import { defineConfig } from 'vitest/config';
import path from 'path';

// Separate vitest config for the rules tests. They need the Firebase emulator
// running (which `npm run test:rules` boots via firebase-tools:exec), so we
// keep them OUT of the default `npm test` to keep that fast and zero-dep.
export default defineConfig({
  test: {
    include: ['test/rules/**/*.test.ts'],
    environment: 'node',
    // Cold-start emulator round-trips can take longer than vitest's default.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './') },
  },
});
