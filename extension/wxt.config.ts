import { defineConfig } from 'wxt';
import { resolve } from 'node:path';
import { BRAND, GECKO_ID } from './brand';
import { hardenLibraries } from './harden-libs';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // MV3 everywhere (Firefox ≥128 supports it), so `browser.action`, `scripting`
  // and the sidebar behave the same across builds.
  manifestVersion: 3,
  srcDir: '.',
  outDir: '.output',
  alias: {
    '@shared': resolve(__dirname, '../shared'),
  },
  vite: () => ({
    // KaTeX ships fonts; keep them inline-free and let WXT copy them.
    build: { target: 'es2022' },
    // React and pdf.js without their innerHTML, eval and computed-import
    // paths (see harden-libs.ts), in the page bundles and in the worker
    // bundle Vite builds separately.
    plugins: [hardenLibraries()],
    worker: { plugins: () => [hardenLibraries()] },
    server: {
      // Vite 8 restricts dev-server CORS to http(s) localhost origins, so an
      // extension page asking for a module gets no Access-Control-Allow-Origin
      // and every script in sidepanel.html / popup.html is blocked. Extension
      // origins have to be allowed explicitly; without this `pnpm dev` serves
      // blank pages while `pnpm build` works fine.
      cors: { origin: [/^https?:\/\/(?:[^:]+\.)?localhost(?::\d+)?$/, /^chrome-extension:\/\//, /^moz-extension:\/\//] },
    },
  }),
  hooks: {
    // The content script is injected at runtime under activeTab, so no host
    // permission is needed. WXT adds one from `matches`; strip it to keep the
    // store checklist: activeTab, scripting, storage, sidePanel only.
    //
    // Two exceptions. E2E=1: activeTab is granted only by a real user gesture
    // on the toolbar, which Playwright cannot deliver, so the test build takes
    // a host permission instead. And `wxt dev`, where WXT adds the dev server
    // origin here so extension pages can reach it — stripping that leaves the
    // dev build unable to load its own scripts. Never set E2E for a store
    // build; `pnpm zip` and the release workflow don't.
    'build:manifestGenerated': (wxt, manifest) => {
      if (process.env.E2E === '1') {
        manifest.host_permissions = ['<all_urls>'];
        return;
      }
      if (wxt.config.command === 'serve') return;
      delete manifest.host_permissions;
      if (manifest.permissions) manifest.permissions = manifest.permissions.filter((p) => p !== '<all_urls>');
    },
  },
  manifest: ({ browser, manifestVersion }) => {
    const base = {
      // Name, description and titles live in brand.ts so a rename is one edit.
      name: BRAND.name,
      short_name: BRAND.shortName,
      description: BRAND.description,
      // Permissions are kept to the store checklist: activeTab, scripting, storage, sidePanel.
      permissions: ['activeTab', 'scripting', 'storage', ...(browser === 'firefox' ? [] : ['sidePanel'])],
      host_permissions: [] as string[],
      // The default for extension pages, plus WebAssembly for the PDF
      // reader's image decoders (pdf.js). No remote code, no eval.
      content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
      // Alt/Option+Shift+S is the one family free in Chrome, Edge and Firefox
      // on both Windows and Mac (checked against each browser's published
      // shortcut list); every Ctrl/Cmd+Shift letter is taken somewhere. It is
      // bound to _execute_action, the browser's own "click the icon" command,
      // so the shortcut behaves exactly like the icon: same user gesture, same
      // activeTab grant, same panel opening. The per-mode commands have no
      // default key; students can bind them. (Text used to ship Alt+Shift+A,
      // but that is Chrome's own "focus inactive dialogs", so Chrome silently
      // left it unassigned.)
      commands: {
        _execute_action: {
          suggested_key: { default: 'Alt+Shift+S', mac: 'Alt+Shift+S' },
          description: `Start a selection, like clicking ${BRAND.iconName}`,
        },
        'select-text': { description: 'Start a text selection' },
        'select-box': { description: 'Start a box selection' },
        'select-element': { description: 'Start an element selection' },
        'select-freeform': { description: 'Start a freeform selection' },
      },
      // No default_popup: clicking the icon brings up the selection bar with a
      // selection already armed, so the page is ready for input on the first
      // click. Modes are switched with the bar's chips.
      action: {
        default_title: BRAND.actionTitle,
      },
      web_accessible_resources: [{ resources: ['reader.html'], matches: ['<all_urls>'] }],
    };

    if (browser === 'firefox') {
      return {
        ...base,
        // Firefox reuses the sidepanel page as its sidebar.
        sidebar_action: {
          default_panel: 'sidepanel.html',
          default_title: BRAND.shortName,
          default_icon: 'icon/128.png',
        },
        browser_specific_settings: {
          gecko: {
            id: GECKO_ID,
            // 140: the first Firefox that shows data-collection consent at install.
            strict_min_version: '140.0',
            // Firefox asks for consent to this at install. What leaves the
            // browser is what the student selects (text or a screenshot of
            // part of a page) and that page's title, sent to the AI they
            // picked; nothing else, and nothing to us. Without it the
            // extension cannot answer, so it is required, not optional.
            data_collection_permissions: { required: ['websiteContent', 'browsingActivity'] },
          },
          // Firefox for Android takes the consent key from 142.
          gecko_android: { strict_min_version: '142.0' },
        },
      };
    }

    if (browser === 'safari') {
      // Safari has no docked panel; overlay.ts renders the same Panel in-page.
      return { ...base, permissions: base.permissions.filter((p) => p !== 'sidePanel') };
    }

    void manifestVersion;
    return base;
  },
});
