/**
 * Loads the unpacked Chrome build (extension/.output/chrome-mv3) into a
 * persistent Chromium context and exposes the extension id and its service
 * worker. Build with `pnpm build:e2e` first — that build carries a host
 * permission the shipped one does not (see wxt.config.ts).
 */
import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const EXTENSION_PATH = resolve(__dirname, '../../extension/.output/chrome-mv3');
export const FIXTURE_ORIGIN = 'http://localhost:5174';

export const test = base.extend<{ context: BrowserContext; extensionId: string; serviceWorker: Worker }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'selection-ai-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    await use(sw);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(serviceWorker.url().split('/')[2]!);
  },
});

export const expect = test.expect;

/**
 * Injects the content script into the tab showing `url` and starts a
 * selection there, as the toolbar click does. The tab is matched by URL
 * because the panel tab, not the fixture, may be the active one.
 */
export async function startSelection(serviceWorker: Worker, kind: 'box' | 'text' | 'element', url: string): Promise<void> {
  await serviceWorker.evaluate(
    async ({ kind, url }: { kind: string; url: string }) => {
      const [tab] = await chrome.tabs.query({ url });
      if (!tab?.id) throw new Error(`no tab for ${url}`);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-scripts/content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'selection:start', kind });
    },
    { kind, url },
  );
}

/**
 * Opens the panel page in a tab. The side panel proper is not reachable from
 * Playwright, and the page is identical, so this exercises the same code.
 * Messages to the background must come from here: a service worker never
 * receives its own runtime.sendMessage.
 */
export async function openPanel(context: BrowserContext, extensionId: string) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}
