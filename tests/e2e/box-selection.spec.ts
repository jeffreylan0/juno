/**
 * Loads the unpacked extension, opens a fixture page, draws a box with the
 * content script, and checks the plan the background produced and the answer
 * the panel receives. Runs against the mock provider, so it costs nothing.
 */
import type { Page } from '@playwright/test';
import { FIXTURE_ORIGIN, expect, openPanel, startSelection, test } from './fixtures';
import type { Plan } from '../../shared/payload';

const getPlan = async (panel: Page) =>
  (await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'plan:get' }))) as Plan | null;

/** Draws a box around `selector` on `page` and waits for the plan. */
async function boxAround(page: Page, panel: Page, selector: string, pad = 4): Promise<Plan> {
  const box = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(box.x - pad, box.y - pad);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + pad, box.y + box.height + pad, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await getPlan(panel))?.parts.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  return (await getPlan(panel))!;
}

test('a box selection produces a plan with an image part and the visible text', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/text.html`);
  const panel = await openPanel(context, extensionId);
  await page.bringToFront(); // captureVisibleTab grabs the window's active tab
  await startSelection(serviceWorker, 'box', `${FIXTURE_ORIGIN}/text.html`);

  const plan = await boxAround(page, panel, '#problem');

  expect(plan.selection.kind).toBe('box');
  expect(plan.route).toBe('large');
  const kinds = plan.parts.map((p) => p.kind);
  expect(kinds).toContain('image');
  expect(kinds).toContain('text');

  const text = plan.parts.find((p) => p.kind === 'text');
  expect(text && text.kind === 'text' ? text.text : '').toContain('Balance the equation');
  // The decoys are white-on-white and 1px; neither may reach the model.
  expect(JSON.stringify(plan.parts.filter((p) => p.kind !== 'image'))).not.toContain('decoy');

  const image = plan.parts.find((p) => p.kind === 'image');
  expect(image?.kind === 'image' && image.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  // The overlay must be gone before the capture, so the crop has no blue tint.
  await expect(page.locator('selection-ai-overlay')).toHaveCount(0);
});

test('the panel streams a mock answer for that plan', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/katex.html`);
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', `${FIXTURE_ORIGIN}/katex.html`);
  await boxAround(page, panel, '#problem');

  const answer = await panel.evaluate(async () => {
    const plan = await chrome.runtime.sendMessage({ type: 'plan:get' });
    return await new Promise<string>((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'selection-ai:ask' });
      let text = '';
      const timer = setTimeout(() => reject(new Error('timed out')), 25_000);
      port.onMessage.addListener((chunk: { type: string; text?: string; message?: string }) => {
        if (chunk.type === 'delta') text += chunk.text ?? '';
        else if (chunk.type === 'done') {
          clearTimeout(timer);
          resolve(text);
        } else if (chunk.type === 'error') {
          clearTimeout(timer);
          reject(new Error(chunk.message));
        }
      });
      port.postMessage({ type: 'ask:start', request: { plan } });
    });
  });

  expect(answer.startsWith('Read:')).toBe(true);
  expect(answer).toContain('Mock answer');
});

test('escape cancels without producing a plan', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  await page.goto(`${FIXTURE_ORIGIN}/table.html`);
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', `${FIXTURE_ORIGIN}/table.html`);

  await expect(page.locator('selection-ai-overlay')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('selection-ai-overlay')).toHaveCount(0);
  expect(await getPlan(panel)).toBeNull();
});
