/**
 * The bar and the panel: the icon brings the bar up on a tab; the first
 * selection opens the panel, which stays open from tab to tab. Leaving a tab
 * takes its bar away, and the icon brings it back wherever the student is;
 * every selection joins the one chat. ✕ on either, or Escape on a waiting
 * bar, hides both and finishes the chat; the icon then starts a new one. The
 * ghost on the bar makes the next selection start a temporary chat.
 */
import type { Page, Worker } from '@playwright/test';
import { FIXTURE_ORIGIN, boxAndAsk, closeSidePanels, currentChat, expect, openPanel, savedChats, sidePanelCount, startSelection, test } from './fixtures';

const OVERLAY = 'selection-ai-overlay';
const BAR = `${OVERLAY} .bar`;

/** Clicks the toolbar icon for the tab showing `url`, as a student does. */
async function clickIcon(sw: Worker, url: string): Promise<void> {
  await sw.evaluate(async (u: string) => {
    const [tab] = await chrome.tabs.query({ url: u });
    // @ts-expect-error test-only dispatch; Chrome has no API to click the icon.
    chrome.action.onClicked.dispatch(tab);
  }, url);
}

async function open(page: Page, path: string): Promise<string> {
  const url = `${FIXTURE_ORIGIN}/${path}`;
  await page.goto(url);
  return url;
}

const chatCount = (sw: Worker) =>
  sw.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('current:')).length);

/** Records, from here on, every time the bar leaves the page or steps out of view. */
async function watchBar(page: Page): Promise<() => Promise<{ removed: number; hidden: number; flew: number }>> {
  await page.evaluate(() => {
    const seen = { removed: 0, hidden: 0, flew: 0 };
    (window as unknown as { __bar: typeof seen }).__bar = seen;
    const host = document.querySelector('selection-ai-overlay')!;
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.removedNodes) if (n === host) seen.removed++;
    }).observe(document.documentElement, { childList: true });
    const shadow = host.shadowRoot!;
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && (r.target as Element).classList.contains('out-of-shot')) seen.hidden++;
        for (const n of r.addedNodes) if ((n as Element).classList?.contains('fly')) seen.flew++;
      }
    }).observe(shadow, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  return () => page.evaluate(() => (window as unknown as { __bar: { removed: number; hidden: number; flew: number } }).__bar);
}

test('the bar stays up through a selection and waits; a chip starts the next one; Escape then hides both', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await expect(page.locator(BAR)).toBeVisible({ timeout: 10_000 });
  const seen = await watchBar(page);
  await boxAndAsk(page, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });

  // Never taken off the page, nor out of view: the box was nowhere near it.
  // And nothing is animated for the selection itself.
  expect(await seen()).toEqual({ removed: 0, hidden: 0, flew: 0 });

  // Waiting: no mode pressed, nothing over the page, the page takes clicks.
  const overlay = page.locator(OVERLAY);
  await expect(overlay).toHaveAttribute('data-state', 'ready');
  await expect(page.locator(`${BAR} .say`)).toHaveText('Pick a mode to select');
  await expect(page.locator(`${BAR} .chip[aria-pressed="true"]`)).toHaveCount(0);
  const p = (await page.locator('#problem').boundingBox())!;
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x: p.x + 5, y: p.y + p.height / 2 })).toBe('problem');

  // One click on a chip, and the next selection joins the same chat.
  await page.locator(`${BAR} .chip[data-kind="box"]`).click();
  await expect(overlay).toHaveAttribute('data-state', 'armed');
  await boxAndAsk(page, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(2, { timeout: 15_000 });
  await expect(overlay).toHaveAttribute('data-state', 'ready');

  // Escape while selecting stops the selection; the bar waits.
  await page.locator(`${BAR} .chip[data-kind="box"]`).click();
  await expect(overlay).toHaveAttribute('data-state', 'armed');
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveAttribute('data-state', 'ready');
  expect((await seen()).removed).toBe(0);

  // Escape while it waits: the bar slides out, the panel goes, and the chat is finished.
  const closed = panel.waitForEvent('close', { timeout: 10_000 });
  await page.keyboard.press('Escape');
  await closed;
  await expect(overlay).toHaveCount(0);
  await expect.poll(() => chatCount(serviceWorker)).toBe(0);
});

test('a selection under the bar takes the bar out of the screenshot, and back', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  const bar = page.locator(BAR);
  await expect(bar).toBeVisible({ timeout: 10_000 });
  const seen = await watchBar(page);

  // A box right across the bar.
  const b = (await bar.boundingBox())!;
  await page.mouse.move(b.x - 20, b.y - 30);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 20, b.y + b.height + 8, { steps: 8 });
  await page.mouse.up();
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveClass(/out-of-shot/);
  const after = await seen();
  expect(after.removed).toBe(0);
  expect(after.hidden).toBeGreaterThan(0);
});

test('switching tabs takes the bar away; the icon brings it up on the next, and every selection joins one chat', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const urlA = await open(a, 'text.html');
  const urlB = await open(b, 'table.html');
  const panel = await openPanel(context, extensionId);

  await a.bringToFront();
  await clickIcon(serviceWorker, urlA);
  await boxAndAsk(a, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });
  const chatId = (await currentChat(panel))!.id;

  // To tab B: A's bar goes, and B has none until the icon is clicked there.
  await b.bringToFront();
  await expect(a.locator(OVERLAY)).toHaveCount(0, { timeout: 10_000 });
  await b.waitForTimeout(300);
  await expect(b.locator(OVERLAY)).toHaveCount(0);

  await clickIcon(serviceWorker, urlB);
  await expect(b.locator(OVERLAY)).toHaveAttribute('data-state', 'armed', { timeout: 10_000 });
  await boxAndAsk(b, 'table');
  await expect(panel.getByTestId('selection')).toHaveCount(2, { timeout: 15_000 });
  expect((await currentChat(panel))!.id).toBe(chatId);

  // Back to A: nothing was kept for it.
  await a.bringToFront();
  await expect(b.locator(OVERLAY)).toHaveCount(0, { timeout: 10_000 });
  await a.waitForTimeout(300);
  await expect(a.locator(OVERLAY)).toHaveCount(0);
  // The chat carried on the whole time.
  expect(await chatCount(serviceWorker)).toBe(1);
});

test('the ghost on the bar: no panel until the next selection, which starts a temporary chat', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  const ghost = page.locator(`${BAR} .ghost`);
  await expect(ghost).toHaveAttribute('aria-pressed', 'false', { timeout: 10_000 });

  // The ghost sits just left of the gear.
  const g = (await ghost.boundingBox())!;
  const gear = (await page.locator(`${BAR} .gear`).boundingBox())!;
  expect(g.x + g.width).toBeLessThanOrEqual(gear.x);
  expect(gear.x - (g.x + g.width)).toBeLessThan(16);

  await ghost.click();
  await expect(ghost).toHaveAttribute('aria-pressed', 'true');
  // Still just the bar: the panel waits for the selection.
  await page.waitForTimeout(300);
  expect(await sidePanelCount(serviceWorker)).toBe(0);

  await boxAndAsk(page, '#problem');
  await expect.poll(() => sidePanelCount(serviceWorker), { timeout: 10_000 }).toBe(1);
  const stored = async () =>
    serviceWorker.evaluate(async () => {
      const [cur] = Object.entries(await chrome.storage.session.get(null)).filter(([k]) => k.startsWith('current:'));
      const c = cur?.[1] as { chatId: string; temporary: boolean } | undefined;
      if (!c) return null;
      const session = (await chrome.storage.session.get(`chat:${c.chatId}`))[`chat:${c.chatId}`] as { items: unknown[] } | undefined;
      const local = (await chrome.storage.local.get(`chat:${c.chatId}`))[`chat:${c.chatId}`];
      return { temporary: c.temporary, inMemory: session?.items.length ?? 0, onDisk: !!local };
    });
  await expect.poll(stored, { timeout: 10_000 }).toEqual({ temporary: true, inMemory: 1, onDisk: false });
  expect(await savedChats(serviceWorker)).toEqual([]);
  // The bar still shows it on.
  await expect(ghost).toHaveAttribute('aria-pressed', 'true');

  // ✕ on the bar: the temporary chat is gone, and the next one is not temporary.
  await page.locator(`${BAR} .close`).click();
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await expect.poll(() => chatCount(serviceWorker)).toBe(0);
  await expect
    .poll(async () => serviceWorker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('chat:')).length))
    .toBe(0);
  await clickIcon(serviceWorker, url);
  await expect(ghost).toHaveAttribute('aria-pressed', 'false', { timeout: 10_000 });
});

test('the ghost on the bar mid-chat starts a separate temporary chat; the saved one stays in the menu', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await boxAndAsk(page, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });
  const saved = (await currentChat(panel))!;

  await page.locator(`${BAR} .ghost`).click();
  // The panel follows the bar: a fresh temporary chat, its own ghost on.
  await expect(panel.getByTestId('chat-title')).toHaveText('Temporary chat');
  await expect(panel.getByTestId('temporary')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('ghost-privacy')).toBeVisible();
  await page.locator(`${BAR} .chip[data-kind="box"]`).click();
  await boxAndAsk(page, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });
  expect((await currentChat(panel))!.temporary).toBe(true);
  expect((await savedChats(serviceWorker)).map((c) => c.id)).toEqual([saved.id]);

  // The panel's ghost, turned off, is shown on the bar too.
  await panel.getByTestId('temporary').click();
  await expect(page.locator(`${BAR} .ghost`)).toHaveAttribute('aria-pressed', 'false', { timeout: 10_000 });
});

test('✕ on the side panel takes the bar away too; the icon then starts a new chat', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await boxAndAsk(page, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });
  const chatId = (await currentChat(panel))!.id;

  await closeSidePanels(serviceWorker);
  await panel.close();
  await expect(page.locator(OVERLAY)).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => chatCount(serviceWorker)).toBe(0);

  const again = await openPanel(context, extensionId);
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await boxAndAsk(page, '#problem');
  await expect(again.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });
  expect((await currentChat(again))!.id).not.toBe(chatId);
});

test('Escape before anything is selected means never mind: the bar goes', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'armed', { timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await expect.poll(() => chatCount(serviceWorker)).toBe(0);
});

test('an Escape the page uses for itself, or one typed in a field, leaves the waiting bar alone', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await boxAndAsk(page, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'ready');

  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'search';
    document.body.append(input);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && (e.target as HTMLElement).id === 'dialog' && e.preventDefault());
    const dialog = document.createElement('button');
    dialog.id = 'dialog';
    document.body.append(dialog);
  });
  await page.locator('#search').focus();
  await page.keyboard.press('Escape');
  await page.locator('#dialog').focus();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'ready');
  expect(await chatCount(serviceWorker)).toBe(1);
});

test('on a blocked site the icon brings up no bar, and the tooltip under the icon says why', async ({ context, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings ?? {}), version: 3, blockedSites: ['localhost'] } });
    // Record what the icon's popup is opened with; headless Chrome cannot show it.
    const g = globalThis as unknown as { opened: string[] };
    g.opened = [];
    chrome.action.openPopup = async () => {
      g.opened.push(await chrome.action.getPopup({}));
    };
  });
  await new Promise((r) => setTimeout(r, 200));
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await expect
    .poll(() => serviceWorker.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
    .toEqual([`chrome-extension://${extensionId}/notice.html?kind=blocked-site`]);
  // And the popup goes back to nothing, so the next click is a click.
  await expect.poll(() => serviceWorker.evaluate(() => chrome.action.getPopup({}))).toBe('');
  await expect(page.locator(OVERLAY)).toHaveCount(0);

  // Nor does a per-mode shortcut, which goes around the icon's own check.
  await startSelection(serviceWorker, 'box', url);
  await page.waitForTimeout(500);
  await expect(page.locator(OVERLAY)).toHaveCount(0);

  // What the tooltip says, and its way to the setting.
  const tip = await context.newPage();
  await tip.goto(`chrome-extension://${extensionId}/notice.html?kind=blocked-site`);
  await expect(tip.getByTestId('notice-blocked-site')).toContainText('Juno is off on this site.');
  await expect(tip.locator('.sai-tip-x')).toBeVisible();
  await expect(tip.locator('.sai-tip-actions button')).toHaveText(['Change']);
});

test('the first install asks once to pin the icon, and shows how', async ({ context, extensionId }) => {
  const tip = await context.newPage();
  await tip.goto(`chrome-extension://${extensionId}/notice.html?kind=pin`);
  await expect(tip.getByTestId('pin-tip')).toContainText('Pin Juno');
  await tip.getByTestId('pin-how').click();
  await expect(tip.getByTestId('pin-tip')).toContainText('Click the puzzle piece');
  await expect(tip.locator('.sai-tip-actions button')).toHaveCount(0);
});

test('a bar left behind by a reloaded extension goes quietly at the first click, and says how to get it back', async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await expect(page.locator(BAR)).toBeVisible({ timeout: 10_000 });

  // The extension reloads under the page (an update, or `pnpm dev`): this
  // copy of the content script is orphaned, and every extension call throws.
  await serviceWorker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await page.waitForTimeout(1500);

  await page.locator(`${BAR} .chip[data-kind="freeform"]`).click();
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await expect(page.locator('selection-ai-tooltip .sai-tip')).toContainText('was updated. Click its icon to start again.');
});
