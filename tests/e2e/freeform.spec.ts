/**
 * Freeform: draw a loop, and the AI gets the loop's bounding box with
 * everything outside the outline blanked. And how screenshots show in the
 * panel.
 */
import type { Page } from '@playwright/test';
import { FIXTURE_ORIGIN, boxAndAsk, expect, openPanel, startSelection, tabIdFor, test } from './fixtures';
import type { Plan } from '../../shared/payload';

const OVERLAY = 'selection-ai-overlay';
const URL = `${FIXTURE_ORIGIN}/element.html`;

const getPlan = async (panel: Page, tabId: number) =>
  (await panel.evaluate(async (id) => chrome.runtime.sendMessage({ type: 'plan:get', tabId: id }), tabId)) as Plan | null;

/** RGB of one pixel of a data-URL image, read in the panel page. */
async function pixel(panel: Page, dataUrl: string, x: number, y: number): Promise<number[]> {
  return await panel.evaluate(
    async ({ dataUrl, x, y }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    },
    { dataUrl, x, y },
  );
}

test('freeform: a drawn loop sends its bounding box with the outside blanked', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto(URL);
  const tabId = await tabIdFor(serviceWorker, URL);
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'freeform', URL);
  await expect(page.locator(`${OVERLAY} .chip[data-kind="freeform"]`)).toHaveAttribute('aria-pressed', 'true');

  // A circle inside the red swatch.
  const swatch = (await page.locator('#swatch').boundingBox())!;
  const cx = swatch.x + swatch.width / 2;
  const cy = swatch.y + swatch.height / 2;
  const r = 80;
  await page.mouse.move(cx + r, cy);
  await page.mouse.down();
  for (let i = 1; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'drawing');
  await expect(page.locator(`${OVERLAY} .lasso-line`)).toHaveAttribute('d', /^M/);
  await page.mouse.up();

  await expect.poll(async () => (await getPlan(panel, tabId))?.selection.kind ?? null, { timeout: 15_000 }).toBe('freeform');
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'ready');
  const plan = (await getPlan(panel, tabId))!;
  expect(plan.parts.map((p) => p.kind)).toEqual(['image']);
  expect(Math.abs(plan.selection.rect.width - 2 * r)).toBeLessThan(4);
  const image = plan.parts[0]!;
  if (image.kind !== 'image') throw new Error('expected an image');

  // Inside the loop: the swatch's red. The corners of the bounding box lie
  // outside the loop, so they were blanked to white.
  const centre = await pixel(panel, image.dataUrl, Math.floor(image.width / 2), Math.floor(image.height / 2));
  expect(centre[0]).toBeGreaterThan(180);
  expect(centre[1]).toBeLessThan(80);
  expect(await pixel(panel, image.dataUrl, 2, 2)).toEqual([255, 255, 255]);
  expect(await pixel(panel, image.dataUrl, image.width - 3, image.height - 3)).toEqual([255, 255, 255]);

  await expect(panel.getByTestId('selection-kind')).toHaveText('Freeform');
  // In the panel, only the inside of the outline shows, over a checkerboard,
  // with the outline drawn on, so it is plain what was selected.
  expect(plan.selection.outline!.length).toBeGreaterThan(20);
  await expect(panel.getByTestId('selection-frame')).toBeVisible();
  await expect(panel.locator('.selection-image')).toHaveAttribute('style', /clip-path: polygon/);
  await expect(panel.locator('.selection-outline path')).toHaveAttribute('d', /^M/);
});

test('every screenshot preview keeps its own shape and sits on the panel background', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto(URL);
  const panel = await openPanel(context, extensionId);
  await panel.setViewportSize({ width: 360, height: 700 });
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', URL);
  await boxAndAsk(page, '#table');
  await expect(panel.getByTestId('selection-frame')).toBeVisible({ timeout: 15_000 });

  const img = panel.locator('.selection-image');
  await expect(img).toHaveJSProperty('complete', true);
  const { natural, shown } = await img.evaluate((el: HTMLImageElement) => ({
    natural: el.naturalWidth / el.naturalHeight,
    shown: el.getBoundingClientRect().width / el.getBoundingClientRect().height,
  }));
  expect(Math.abs(natural - shown)).toBeLessThan(0.02);
  // Nothing around the shot but the panel itself: no card fill, no frame,
  // no checkerboard — the space around a selection is the panel's background.
  const fills = await panel.evaluate(() =>
    ['.selection', '.selection-frame', '.selection-shot'].map((sel) => {
      const cs = getComputedStyle(document.querySelector(sel)!);
      return { bg: cs.backgroundColor, image: cs.backgroundImage, border: cs.borderTopWidth };
    }),
  );
  for (const f of fills) expect(f).toEqual({ bg: 'rgba(0, 0, 0, 0)', image: 'none', border: '0px' });
});
