import { defineConfig } from 'wxt';
import { resolve } from 'node:path';

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
      name: 'Selection AI',
      short_name: 'Selection AI',
      description:
        'Select text, a box or a page element and ask Claude or ChatGPT about exactly that. Math, chemistry and physics render properly.',
      // Permissions are kept to the store checklist: activeTab, scripting, storage, sidePanel.
      permissions: ['activeTab', 'scripting', 'storage', ...(browser === 'firefox' ? [] : ['sidePanel'])],
      host_permissions: [] as string[],
      commands: {
        'select-box': {
          suggested_key: { default: 'Alt+Shift+S', mac: 'Alt+Shift+S' },
          description: 'Draw a box and ask about it',
        },
        'select-text': {
          suggested_key: { default: 'Alt+Shift+A', mac: 'Alt+Shift+A' },
          description: 'Ask about the current text selection',
        },
      },
      action: {
        default_title: 'Selection AI',
        // Clicking the icon opens this popup to pick a selection mode; the
        // answer panel opens later, once a selection has been made.
        default_popup: 'popup.html',
      },
    };

    if (browser === 'firefox') {
      return {
        ...base,
        // Firefox reuses the sidepanel page as its sidebar.
        sidebar_action: {
          default_panel: 'sidepanel.html',
          default_title: 'Selection AI',
          default_icon: 'icon/128.png',
        },
        browser_specific_settings: {
          gecko: {
            id: 'selection-ai@amcpmn.org',
            strict_min_version: '128.0',
          },
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
