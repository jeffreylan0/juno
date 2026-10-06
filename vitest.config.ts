import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// WxtVitest wires the extension's aliases (@/, @shared/, #imports) and the
// fake-browser polyfill so lib/ modules run under jsdom.
export default defineConfig({
  plugins: [WxtVitest({ root: 'extension' })],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'jsdom',
    restoreMocks: true,
    // Accounts on, against the fake Supabase in tests/support (never a real one).
    env: { WXT_SUPABASE_URL: 'https://e2e-project.supabase.co', WXT_SUPABASE_KEY: 'sb_publishable_e2e' },
  },
});
