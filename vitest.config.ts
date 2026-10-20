import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// The app's modules under jsdom, with the app's own `browser`
// (desktop/src/platform) over a native core in memory (tests/setup.ts).
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${resolve(__dirname, 'desktop/src')}/` },
      { find: /^@shared\//, replacement: `${resolve(__dirname, 'shared')}/` },
    ],
  },
  envPrefix: ['WXT_'],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    environment: 'jsdom',
    restoreMocks: true,
    // Accounts on, against the fake Supabase in tests/support (never a real one).
    env: { WXT_SUPABASE_URL: 'https://e2e-project.supabase.co', WXT_SUPABASE_KEY: 'sb_publishable_e2e' },
  },
});
