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
    // Now and then, under parallel load, Chromium starts the extension's
    // worker before Playwright is attached and never reports it. A fresh
    // launch fixes that; waiting longer does not.
    for (let attempt = 1; ; attempt++) {
      const userDataDir = mkdtempSync(join(tmpdir(), 'selection-ai-'));
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        // Full Chromium in its new headless mode: Playwright's default headless
        // browser (chromium-headless-shell, since 1.49) cannot load extensions,
        // so every test would wait for a worker that never starts.
        channel: executablePath ? undefined : 'chromium',
        executablePath,
        args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
      });
      if ((await findWorker(context, 10_000)) || attempt === 3) {
        await use(context);
        await context.close();
        return;
      }
      await context.close();
    }
  },
  serviceWorker: async ({ context }, use) => {
    const sw = await findWorker(context, 10_000);
    if (!sw) throw new Error('the extension service worker never started');
    // Just after launch the worker exists before its globals and extension
    // bindings do (setTimeout and chrome.storage both come back undefined).
    // Tests that start by writing settings would race that.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const ready = await sw
        .evaluate(() => typeof setTimeout === 'function' && typeof chrome !== 'undefined' && !!chrome.storage?.local)
        .catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await use(sw);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(serviceWorker.url().split('/')[2]!);
  },
});

export const expect = test.expect;

/**
 * The extension's worker, polled rather than awaited: the 'serviceworker'
 * event can fire between checking serviceWorkers() and starting to wait.
 */
async function findWorker(context: BrowserContext, timeout: number): Promise<Worker | undefined> {
  const deadline = Date.now() + timeout;
  let sw: Worker | undefined;
  while (!(sw = context.serviceWorkers()[0]) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return sw;
}

/**
 * Brings the bar up on the tab showing `url`, selecting in `kind`, the way a
 * per-mode shortcut does: through the background, which injects the content
 * script and keeps track of the tab the bar is on. The tab is matched by URL
 * because the panel tab, not the fixture, may be the active one.
 */
export async function startSelection(serviceWorker: Worker, kind: 'box' | 'text' | 'element' | 'freeform', url: string): Promise<void> {
  await serviceWorker.evaluate(
    async ({ kind, url }: { kind: string; url: string }) => {
      const [tab] = await chrome.tabs.query({ url });
      if (!tab?.id) throw new Error(`no tab for ${url}`);
      // @ts-expect-error test-only dispatch; Chrome has no API to press a shortcut.
      chrome.commands.onCommand.dispatch(`select-${kind}`, tab);
    },
    { kind, url },
  );
}

/**
 * Opens the panel page in a tab of the same window. The side panel proper is
 * not reachable from Playwright, and the page is identical, so this exercises
 * the same code: it connects to the background as a panel of this window, and
 * shows (and adds to) that window's chat. Messages to the background must come
 * from here: a service worker never receives its own runtime.sendMessage.
 */
export async function openPanel(context: BrowserContext, extensionId: string) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  // Connected, with a chat to show (empty until something is selected).
  await expect(panel.locator('.panel[data-chat]:not([data-chat=""])')).toHaveCount(1);
  return panel;
}

export interface StoredChat {
  id: string;
  title: string;
  temporary?: boolean;
  items: Array<{ kind: string; id: string; text?: string; selections?: string[]; streaming?: boolean; error?: string; plan?: { page: { url: string; title: string } } }>;
}

/** The chat this panel's window shows, read from storage as the panel reads it. */
export async function currentChat(panel: Page): Promise<StoredChat | null> {
  return (await panel.evaluate(async () => {
    const w = await chrome.windows.getCurrent();
    const cur = (await chrome.storage.session.get(`current:${w.id}`))[`current:${w.id}`] as { chatId: string } | undefined;
    if (!cur) return null;
    const key = `chat:${cur.chatId}`;
    return (await chrome.storage.local.get(key))[key] ?? (await chrome.storage.session.get(key))[key] ?? null;
  })) as StoredChat | null;
}

/** The saved chats, as the menu lists them. */
export async function savedChats(sw: Worker): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
  return await sw.evaluate(async () => ((await chrome.storage.local.get('chatIndex')).chatIndex ?? []) as Array<{ id: string; title: string; updatedAt: number }>);
}

/**
 * Closes Chrome's own side panel wherever it opened (a drag's gesture opens
 * it, even in tests), so that closing the panel tab really closes every panel.
 */
export async function closeSidePanels(sw: Worker): Promise<void> {
  await sw.evaluate(async () => {
    const sp = chrome.sidePanel as unknown as { close?: (o: { windowId: number }) => Promise<void> };
    for (const w of await chrome.windows.getAll()) await sp.close?.({ windowId: w.id! }).catch(() => {});
  });
  await expect.poll(() => sidePanelCount(sw)).toBe(0);
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
    // Current settings version (lib/storage.ts SETTINGS_VERSION): without it,
    // the migration treats these as old settings and resets changed defaults.
    await chrome.storage.local.set({ settings: { ...(settings ?? {}), version: 3, ...p } });
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

/** Draws a box around `selector`; with the default settings, letting go sends it to the panel. */
export async function boxAndAsk(page: Page, selector: string, pad = 4): Promise<void> {
  const box = (await page.locator(selector).boundingBox())!;
  await dragBox(page, box.x - pad, box.y - pad, box.x + box.width + pad, box.y + box.height + pad);
}
