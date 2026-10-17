import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// The app's modules under jsdom, with a fake WebExtension `browser`
// (tests/setup.ts) where the app puts its own (desktop/src/platform).
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${resolve(__dirname, 'desktop/src')}/` },
      { find: /^@shared\//, replacement: `${resolve(__dirname, 'shared')}/` },
    ],
  },
  envPrefix: ['WXT_', 'VITE_'],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    environment: 'jsdom',
    restoreMocks: true,
    // Accounts on, against the fake Supabase in tests/support (never a real one).
    env: { WXT_SUPABASE_URL: 'https://e2e-project.supabase.co', WXT_SUPABASE_KEY: 'sb_publishable_e2e' },
  },
});
