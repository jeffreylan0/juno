/**
 * The app's web layer: four pages (core, overlay, panel, settings) built from
 * the extension's own code. The aliases are the whole adapter:
 *
 *   @/brand, @/lib/surface   the app's versions (src/brand.ts, src/surface.tsx)
 *   @/…                      the extension (shared code, unchanged)
 *   #imports, wxt/browser    WXT's helpers, over the app's `browser` (src/platform)
 *
 * Settings for accounts and hosted answers come from the same .env files as
 * the extension's (WXT_SUPABASE_URL, WXT_SUPABASE_KEY, WXT_GATEWAY_URL).
 */
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string) => resolve(__dirname, p);
const extension = here('../extension');

const pages: Record<string, string> = {
  core: here('web/core.html'),
  overlay: here('web/overlay.html'),
  panel: here('web/panel.html'),
  settings: here('web/settings.html'),
};
// The end-to-end tests select over a page with known pixels; it never ships.
if (process.env.SAI_E2E === '1') pages.fixture = here('web/fixture.html');

export default defineConfig({
  // The package is the root, so the pages' /src/… scripts resolve alike in
  // development and in a build; the pages themselves are under web/.
  root: here('.'),
  envDir: extension,
  envPrefix: ['WXT_', 'VITE_'],
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\/brand$/, replacement: here('src/brand.ts') },
      { find: /^@\/lib\/surface$/, replacement: here('src/surface.tsx') },
      { find: /^@\//, replacement: `${extension}/` },
      { find: /^@shared\//, replacement: `${here('../shared')}/` },
      { find: /^#imports$/, replacement: here('src/platform/imports.ts') },
      { find: /^wxt\/browser$/, replacement: here('src/platform/wxt-browser.ts') },
    ],
    // The extension's files and the app's resolve React from different
    // folders; one copy, or hooks break.
    dedupe: ['react', 'react-dom'],
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
});
