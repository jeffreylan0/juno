/**
 * The bar leads, the panel follows: the icon summons the bar on any tab and
 * joins the chat in progress; after each selection the bar waits on its page;
 * its ✕ finishes the chat everywhere; closing only the panel keeps the chat.
 */
import type { Page, Worker } from '@playwright/test';
import { FIXTURE_ORIGIN, boxAndAsk, closeSidePanels, currentChat, expect, openPanel, sidePanelCount, test } from './fixtures';

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

test('after a selection the bar stays, out of the way; a chip starts the next one', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await expect(page.locator(BAR)).toBeVisible({ timeout: 10_000 });
  await boxAndAsk(page, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });

  // Waiting: no mode pressed, nothing over the page, the page takes clicks.
  const overlay = page.locator(OVERLAY);
  await expect(overlay).toHaveAttribute('data-state', 'ready');
  await expect(page.locator(`${BAR} .say`)).toHaveText('Pick a mode to select more');
  await expect(page.locator(`${BAR} .chip[aria-pressed="true"]`)).toHaveCount(0);
  const p = (await page.locator('#problem').boundingBox())!;
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x: p.x + 5, y: p.y + p.height / 2 })).toBe('problem');

  // One click on a chip, and the next selection joins the same chat.
  await page.locator(`${BAR} .chip[data-kind="text"]`).click();
  await expect(overlay).toHaveAttribute('data-state', 'armed');
  await page.mouse.move(p.x + 1, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + p.width - 2, p.y + p.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(panel.getByTestId('selection')).toHaveCount(2, { timeout: 15_000 });
  await expect(overlay).toHaveAttribute('data-state', 'ready');

  // Escape now only stops selecting: the bar keeps waiting.
  await page.locator(`${BAR} .chip[data-kind="box"]`).click();
  await expect(overlay).toHaveAttribute('data-state', 'armed');
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveAttribute('data-state', 'ready');
  expect(((await currentChat(panel))!.items.filter((i) => i.kind === 'selection')).length).toBe(2);
});

test('the icon on another tab joins the chat in progress; ✕ on either bar finishes it everywhere', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const urlA = await open(a, 'text.html');
  const urlB = await open(b, 'table.html');
  let panel = await openPanel(context, extensionId);

  await a.bringToFront();
  await clickIcon(serviceWorker, urlA);
  await expect(a.locator(BAR)).toBeVisible({ timeout: 10_000 });
  await boxAndAsk(a, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });
  const chatId = (await currentChat(panel))!.id;

  await b.bringToFront();
  await clickIcon(serviceWorker, urlB);
  await expect(b.locator(BAR)).toBeVisible({ timeout: 10_000 });
  await boxAndAsk(b, 'table');
  await expect(panel.getByTestId('selection')).toHaveCount(2, { timeout: 15_000 });
  expect((await currentChat(panel))!.id).toBe(chatId);
  // Tab A's bar is still waiting there.
  await expect(a.locator(OVERLAY)).toHaveAttribute('data-state', 'ready');

  // ✕ on B's bar: both bars go, the panel closes, the chat is finished.
  const closed = panel.waitForEvent('close', { timeout: 10_000 });
  await b.locator(`${BAR} .close`).click();
  await closed;
  await expect(b.locator(OVERLAY)).toHaveCount(0);
  await expect(a.locator(OVERLAY)).toHaveCount(0);
  await expect.poll(() => chatCount(serviceWorker)).toBe(0);

  // The icon now starts a new chat.
  panel = await openPanel(context, extensionId);
  await a.bringToFront();
  await clickIcon(serviceWorker, urlA);
  await boxAndAsk(a, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });
  expect((await currentChat(panel))!.id).not.toBe(chatId);
});

test('arming on another tab puts the first tab’s bar back to waiting', async ({ context, serviceWorker }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const urlA = await open(a, 'text.html');
  const urlB = await open(b, 'table.html');
  await a.bringToFront();
  await clickIcon(serviceWorker, urlA);
  await expect(a.locator(OVERLAY)).toHaveAttribute('data-state', 'armed', { timeout: 10_000 });
  await b.bringToFront();
  await clickIcon(serviceWorker, urlB);
  await expect(b.locator(OVERLAY)).toHaveAttribute('data-state', 'armed', { timeout: 10_000 });
  await expect(a.locator(OVERLAY)).toHaveAttribute('data-state', 'ready');
});

test('closing only the panel keeps the chat while the bar is up; the next selection brings it back', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  let panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await boxAndAsk(page, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });
  const chatId = (await currentChat(panel))!.id;

  await closeSidePanels(serviceWorker);
  await panel.close();
  await page.waitForTimeout(1_500);
  expect(await chatCount(serviceWorker)).toBe(1);

  // A chip on the waiting bar: the selection lands in the same chat, and the
  // panel opens again on it.
  await page.bringToFront();
  await page.locator(`${BAR} .chip[data-kind="box"]`).click();
  await boxAndAsk(page, '#problem');
  await expect.poll(() => sidePanelCount(serviceWorker), { timeout: 10_000 }).toBe(1);
  panel = await openPanel(context, extensionId);
  await expect(panel.getByTestId('selection')).toHaveCount(2, { timeout: 15_000 });
  expect((await currentChat(panel))!.id).toBe(chatId);
});

test('with no bar and no panel left, the chat is over', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await boxAndAsk(page, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });

  // The page navigates away (its bar with it), then the panel closes.
  await page.goto(`${FIXTURE_ORIGIN}/table.html`);
  await closeSidePanels(serviceWorker);
  await panel.close();
  await expect.poll(() => chatCount(serviceWorker), { timeout: 10_000 }).toBe(0);
});
