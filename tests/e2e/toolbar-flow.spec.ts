/**
 * The toolbar flow: one click arms a selection, the bar carries the controls,
 * the cursor tooltip appears only while a selection is being drawn, the page
 * still scrolls, and the bar itself is never selectable.
 */
import type { Page, Worker } from '@playwright/test';
import { FIXTURE_ORIGIN, expect, openPanel, test } from './fixtures';
import type { Plan } from '../../shared/payload';

const OVERLAY = 'selection-ai-overlay';
const BAR = `${OVERLAY} .bar`;
const TIP = `${OVERLAY} .tip`;

const getPlan = async (panel: Page) =>
  (await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'plan:get' }))) as Plan | null;

/** Clicks the toolbar action the way a user does, from the service worker. */
async function clickToolbar(sw: Worker, url: string): Promise<void> {
  await sw.evaluate(async (u: string) => {
    const [tab] = await chrome.tabs.query({ url: u });
    // @ts-expect-error test-only dispatch; Chrome has no API to click the icon.
    chrome.action.onClicked.dispatch(tab);
  }, url);
}

async function armed(sw: Worker, page: Page, path = 'text.html'): Promise<void> {
  const url = `${FIXTURE_ORIGIN}/${path}`;
  await page.goto(url);
  await page.bringToFront();
  await clickToolbar(sw, url);
  await expect(page.locator(BAR)).toBeVisible({ timeout: 10_000 });
}

test('one toolbar click arms a box selection with the bar in place', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);

  const bar = page.locator(BAR);
  await expect(bar.locator('.chip[data-kind="box"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.locator('.chip[data-kind="text"]')).toBeEnabled();
  await expect(bar.locator('.chip[data-kind="element"]')).toBeDisabled();
  await expect(bar.locator('.close')).toBeVisible();
  await expect(bar.locator('.gear')).toBeVisible();
  await expect(bar.locator('.say')).toHaveText('Drag to select an area');

  // The bar sits near the bottom of the viewport, out of the reading line.
  const box = (await bar.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y + box.height).toBeGreaterThan(viewport.height * 0.7);

  // Nothing follows the cursor until a selection is actually being drawn.
  await expect(page.locator(TIP)).toBeHidden();
});

test('the tooltip takes over from the bar for the duration of the drag', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  const host = page.locator(OVERLAY);
  const tip = page.locator(TIP);

  const target = (await page.locator('#problem').boundingBox())!;
  await page.mouse.move(target.x - 4, target.y - 4);
  await page.mouse.down();
  await page.mouse.move(target.x + 120, target.y + 60, { steps: 6 });

  await expect(host).toHaveAttribute('data-state', 'drawing');
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText('Escapeto cancel');
  await expect(tip.locator('kbd')).toHaveText('Escape');
  // The bar's instruction steps aside rather than competing with it.
  await expect(page.locator(`${BAR} .say`)).toBeHidden();

  // The tooltip is anchored to the pointer, not parked in the middle.
  const first = (await tip.boundingBox())!;
  await page.mouse.move(target.x + 300, target.y + 200, { steps: 6 });
  const second = (await tip.boundingBox())!;
  expect(second.x).not.toBe(first.x);
  expect(Math.abs(second.x - (target.x + 300))).toBeLessThan(140);
  expect(Math.abs(second.y - (target.y + 200))).toBeLessThan(140);

  await page.mouse.up();
});

test('the cancel button ends the selection like Escape does', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();

  await page.locator(`${BAR} .close`).click();
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  expect(await getPlan(panel)).toBeNull();
});

test('the page still scrolls while a selection is armed', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page, 'long.html');

  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 100);

  // The selection survives the scroll; it is not silently cancelled.
  await expect(page.locator(BAR)).toBeVisible();
});

test('keyboard scrolling works, so the overlay never stole focus', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page, 'long.html');

  const before = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('PageDown');
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 100);
});

test('clicking the bar never starts a selection', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();

  // A press and drag that begins on the bar must be inert.
  const bar = (await page.locator(BAR).boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 4);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width / 2 + 200, bar.y - 200, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'armed');
  expect(await getPlan(panel)).toBeNull();
});

test('the gear expands the bar upwards into settings', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  const bar = page.locator(BAR);
  const settings = page.locator(`${BAR} .settings`);

  const closedBottom = (await bar.boundingBox())!.y + (await bar.boundingBox())!.height;
  const closedTop = (await bar.boundingBox())!.y;

  await bar.locator('.gear').click();
  await expect(settings).toHaveClass(/open/);
  await expect(settings.locator('select')).toHaveCount(4);

  const open = (await bar.boundingBox())!;
  // It grew upward: the top rose, the bottom stayed put.
  expect(open.y).toBeLessThan(closedTop);
  expect(Math.abs(open.y + open.height - closedBottom)).toBeLessThan(4);

  // No secrets in page-reachable DOM.
  await expect(page.locator(`${BAR} input[type="password"]`)).toHaveCount(0);
  await expect(settings).toContainText('All settings, keys and prompts');
});

test('a completed selection still produces a plan', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();

  const target = (await page.locator('#problem').boundingBox())!;
  await page.mouse.move(target.x - 4, target.y - 4);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width + 4, target.y + target.height + 4, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await getPlan(panel))?.parts.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  const plan = (await getPlan(panel))!;
  expect(plan.parts.map((p) => p.kind)).toContain('image');

  const badge = await serviceWorker.evaluate(async () => chrome.action.getBadgeText({}));
  expect(badge, 'panel needed a manual click; the gesture did not carry').toBe('');
});

test('when Chrome refuses the panel, the page offers a click that opens it', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);

  // Drive the fallback directly; the refusal itself cannot be provoked here.
  await serviceWorker.evaluate(async (u: string) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await chrome.tabs.sendMessage(tab!.id!, { type: 'panel:needs-click' });
  }, `${FIXTURE_ORIGIN}/text.html`);

  const toast = page.locator('selection-ai-toast .toast');
  await expect(toast).toBeVisible();
  await toast.locator('button', { hasText: 'Show it' }).click();
  await expect(page.locator('selection-ai-toast')).toHaveCount(0);
});
