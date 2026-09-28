/**
 * The toolbar flow: the popup arms a selection, the page stays selectable,
 * Escape cancels from either side, and the answer panel appears only once a
 * selection has been made.
 */
import type { Page } from '@playwright/test';
import { FIXTURE_ORIGIN, clickIn, expect, openPanel, openPopup, test } from './fixtures';
import type { Plan } from '../../shared/payload';

const OVERLAY = 'selection-ai-overlay';

const getPlan = async (panel: Page) =>
  (await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'plan:get' }))) as Plan | null;

test('opening the popup arms a box selection on the page', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/text.html`);
  const popup = await openPopup(context, extensionId, page);

  // The overlay appears without any further interaction.
  await expect(page.locator(OVERLAY)).toHaveCount(1, { timeout: 10_000 });
  // Box is the default, and the popup shows it as the armed mode.
  await expect(popup.locator('button.mode.on')).toHaveText(/Box/);
});

test('the hint sits in the centre of the screen and fades when idle', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/text.html`);
  await openPopup(context, extensionId, page);
  const host = page.locator(OVERLAY);
  await expect(host).toHaveCount(1, { timeout: 10_000 });
  await page.bringToFront();

  // Centred: the hint's midpoint is the viewport's midpoint, within a pixel or two.
  const hint = page.locator(`${OVERLAY} .hint`);
  await expect(hint).toBeVisible();
  const box = (await hint.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(3);
  expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThan(3);
  await expect(hint).toContainText('Drag to select an area');
  await expect(hint).toContainText('Esc');

  // It starts visible, goes quiet on its own, and comes back on activity.
  await expect(host).toHaveAttribute('data-hint', 'visible');
  await expect(host).toHaveAttribute('data-hint', 'faded', { timeout: 10_000 });
  await page.mouse.move(viewport.width / 2, viewport.height / 2 + 120);
  await expect(host).toHaveAttribute('data-hint', 'visible');
});

test('Escape in the page cancels the selection and leaves no plan', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/katex.html`);
  const popup = await openPopup(context, extensionId, page);
  await expect(page.locator(OVERLAY)).toHaveCount(1, { timeout: 10_000 });

  // Switching mode closes the popup in real Chrome; do it here so focus is on
  // the page, exactly as it would be after the popup dismisses itself.
  await clickIn(popup, 'button.mode:has-text("Box")').catch(() => {});
  await page.bringToFront();
  await page.keyboard.press('Escape');

  await expect(page.locator(OVERLAY)).toHaveCount(0);
  const panel = await openPanel(context, extensionId);
  expect(await getPlan(panel)).toBeNull();
});

test('Escape in the popup cancels the page selection too', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/table.html`);
  const popup = await openPopup(context, extensionId, page);
  await expect(page.locator(OVERLAY)).toHaveCount(1, { timeout: 10_000 });

  // While the popup holds focus the page never sees the key, so the popup has
  // to relay it. Dispatch on the popup document, not via the keyboard.
  await popup.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  await expect(page.locator(OVERLAY)).toHaveCount(0);
});

test('the answer panel stays away until a selection is made', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/text.html`);
  const panel = await openPanel(context, extensionId);
  await openPopup(context, extensionId, page);
  await expect(page.locator(OVERLAY)).toHaveCount(1, { timeout: 10_000 });

  // Armed but nothing selected: no plan for the panel to show.
  expect(await getPlan(panel)).toBeNull();

  await page.bringToFront();
  const box = (await page.locator('#problem').boundingBox())!;
  await page.mouse.move(box.x - 4, box.y - 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 4, box.y + box.height + 4, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await getPlan(panel))?.parts.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);

  // The action opens the popup, so nothing can open the panel on icon click.
  const action = await serviceWorker.evaluate(() => chrome.runtime.getManifest().action);
  expect(action?.default_popup).toBe('popup.html');
});
