import { defineConfig } from 'vitest/config';

// The app end to end (tests/e2e): one app at a time, each on its own X display.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
