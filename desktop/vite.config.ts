/**
 * The app's web layer: four pages (core, overlay, panel, settings), with
 * `@/` for src/ and `@shared/` for the code the hosted-answers Worker shares.
 * Accounts and hosted answers are set by WXT_SUPABASE_URL, WXT_SUPABASE_KEY
 * and WXT_GATEWAY_URL in the repository's .env.local (or the environment).
 */
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { hardenLibraries } from './harden-libs';

const here = (p: string) => resolve(__dirname, p);

const pages: Record<string, string> = {
  core: here('web/core.html'),
  overlay: here('web/overlay.html'),
  panel: here('web/panel.html'),
  settings: here('web/settings.html'),
};
// The end-to-end tests select over a page with known pixels; it never ships.
if (process.env.SAI_E2E === '1') pages.fixture = here('web/fixture.html');

/** The account and hosted-answer addresses: https, or this computer while developing. */
function checkAddresses(mode: string): void {
  const env = loadEnv(mode, here('..'), 'WXT_');
  for (const name of ['WXT_SUPABASE_URL', 'WXT_GATEWAY_URL']) {
    const url = env[name]?.trim();
    if (url && !/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) {
      throw new Error(`${name} must be an https:// address (it is ${url})`);
    }
  }
}

export default defineConfig(({ mode }) => (checkAddresses(mode), {
  // The package is the root, so the pages' /src/… scripts resolve alike in
  // development and in a build; the pages themselves are under web/.
  root: here('.'),
  // The repository's .env.local (see .env.example).
  envDir: here('..'),
  envPrefix: ['WXT_', 'VITE_'],
  // React and DOMPurify without their HTML-string and eval paths (harden-libs.ts).
  plugins: [react(), hardenLibraries()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${here('src')}/` },
      { find: /^@shared\//, replacement: `${here('../shared')}/` },
    ],
  },
  // Tauri expects a fixed port, and its own console output kept.
  server: { port: 5180, strictPort: true },
  clearScreen: false,
  build: {
    outDir: here('dist'),
    emptyOutDir: true,
    // WebKit on macOS 14 (Safari 17) and WebView2 (current Chromium).
    target: ['es2022', 'safari17', 'chrome120'],
    rollupOptions: { input: pages },
  },
}));
