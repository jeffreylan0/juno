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
  },
});
