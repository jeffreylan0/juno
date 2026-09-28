/**
 * Loads the unpacked Chrome build (extension/.output/chrome-mv3) into a
 * persistent Chromium context and exposes the extension id and its service
 * worker. Build with `pnpm build:e2e` first — that build carries a host
 * permission the shipped one does not (see wxt.config.ts).
 */
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
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
export async function openPanel(context: BrowserContext, extensionId: string, tabId?: number) {
  const panel = await context.newPage();
  // A panel opened as a tab would follow itself as "the active tab"; pinning
  // it to the page under test shows that page's thread instead.
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html${tabId !== undefined ? `?tabId=${tabId}` : ''}`);
  return panel;
}

/** The tab id of the page showing `url`. */
export async function tabIdFor(sw: Worker, url: string): Promise<number> {
  return await sw.evaluate(async (u: string) => {
    const [tab] = await chrome.tabs.query({ url: u });
    if (tab?.id === undefined) throw new Error(`no tab for ${u}`);
    return tab.id;
  }, url);
}

/** Merges into the stored settings, as the options page would. */
export async function setSettings(sw: Worker, patch: Record<string, unknown>): Promise<void> {
  await sw.evaluate(async (p: Record<string, unknown>) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings ?? {}), ...p } });
  }, patch);
  // The background caches settings; give its watcher a moment to catch up.
  await new Promise((r) => setTimeout(r, 150));
}

/** How many real side panels are open, from Chrome's own list of contexts. */
export async function sidePanelCount(sw: Worker): Promise<number> {
  return await sw.evaluate(async () => {
    // @ts-expect-error SIDE_PANEL is missing from older @types/chrome
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    return contexts.length;
  });
}

/** Drags a box from (x0, y0) to (x1, y1) with a real mouse. */
export async function dragBox(page: Page, x0: number, y0: number, x1: number, y1: number): Promise<void> {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
}

/**
 * Draws a box around `selector` and sends it. A drawn box waits to be
 * adjusted by default, so this also presses Enter to ask.
 */
export async function boxAndAsk(page: Page, selector: string, pad = 4): Promise<void> {
  const box = (await page.locator(selector).boundingBox())!;
  await dragBox(page, box.x - pad, box.y - pad, box.x + box.width + pad, box.y + box.height + pad);
  await expect(page.locator('selection-ai-overlay')).toHaveAttribute('data-state', 'adjusting');
  await page.keyboard.press('Enter');
}

/**
 * Opens popup.html the way the toolbar does. A real popup is not a tab, so the
 * page under test has to be the active one before the popup mounts — otherwise
 * the background arms the selection in the popup's own tab.
 */
export async function openPopup(context: BrowserContext, extensionId: string, active: Page) {
  const popup = await context.newPage();
  await popup.goto('about:blank');
  await active.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

/** Clicks by dispatching a DOM event, which works in a background tab. */
export async function clickIn(page: Page, selector: string): Promise<void> {
  await page.evaluate((s: string) => {
    const el = document.querySelector<HTMLElement>(s);
    if (!el) throw new Error(`no element for ${s}`);
    el.click();
  }, selector);
}
