/**
 * The bar and the panel are one thing the student shows and hides: the icon
 * brings the bar up, one per window, and it follows the student from tab to
 * tab in whatever state it is in; ✕ on either, or Escape on a waiting bar,
 * hides both and finishes the chat; the icon then starts a new one.
 */
import type { Page, Worker } from '@playwright/test';
import { FIXTURE_ORIGIN, boxAndAsk, closeSidePanels, currentChat, expect, openPanel, test } from './fixtures';

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

test('after a selection the bar waits, out of the way; a chip starts the next one; Escape then hides both', async ({
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

  // Escape while selecting stops the selection; the bar waits.
  await page.locator(`${BAR} .chip[data-kind="box"]`).click();
  await expect(overlay).toHaveAttribute('data-state', 'armed');
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveAttribute('data-state', 'ready');

  // Escape while it waits: the bar and the panel go, and the chat is finished.
  const closed = panel.waitForEvent('close', { timeout: 10_000 });
  await page.keyboard.press('Escape');
  await closed;
  await expect(overlay).toHaveCount(0);
  await expect.poll(() => chatCount(serviceWorker)).toBe(0);
});

test('the bar follows to whichever tab is active, in the same state, and every selection joins one chat', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const urlA = await open(a, 'text.html');
  await open(b, 'table.html');
  const panel = await openPanel(context, extensionId);

  await a.bringToFront();
  await clickIcon(serviceWorker, urlA);
  await boxAndAsk(a, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1, { timeout: 15_000 });
  const chatId = (await currentChat(panel))!.id;

  // To tab B, with no click on the icon: the bar is there, waiting, and gone from A.
  await b.bringToFront();
  await expect(b.locator(OVERLAY)).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
  await expect(a.locator(OVERLAY)).toHaveCount(0);
  await b.locator(`${BAR} .chip[data-kind="box"]`).click();
  await boxAndAsk(b, 'table');
  await expect(panel.getByTestId('selection')).toHaveCount(2, { timeout: 15_000 });
  expect((await currentChat(panel))!.id).toBe(chatId);

  // Armed on B, then back to A: A has it, armed in the same mode.
  await b.locator(`${BAR} .chip[data-kind="freeform"]`).click();
  await expect(b.locator(OVERLAY)).toHaveAttribute('data-state', 'armed');
  await a.bringToFront();
  await expect(a.locator(OVERLAY)).toHaveAttribute('data-state', 'armed', { timeout: 10_000 });
  await expect(a.locator(`${BAR} .chip[data-kind="freeform"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(b.locator(OVERLAY)).toHaveCount(0);

  // A page that loads anew gets the bar back.
  await a.reload();
  await expect(a.locator(OVERLAY)).toHaveAttribute('data-state', 'armed', { timeout: 10_000 });
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
  await expect.poll(async () => serviceWorker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('bar:')).length)).toBe(0);
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

test('on a blocked site the icon brings up no bar, and the panel says why', async ({ context, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings ?? {}), version: 3, blockedSites: ['localhost'] } });
  });
  await new Promise((r) => setTimeout(r, 200));
  const page = await context.newPage();
  const url = await open(page, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await clickIcon(serviceWorker, url);
  await expect(panel.locator('[data-testid="notice"][data-kind="bar-blocked-site"]')).toContainText('blocked sites', { timeout: 10_000 });
  await expect(page.locator(OVERLAY)).toHaveCount(0);
});
