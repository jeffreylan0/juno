/**
 * The PDF reader exists because the browser's own viewer is a plugin a
 * content script cannot scroll: the page freezes while a selection is armed.
 * Rendering the same file with PDF.js gives a page that scrolls while
 * selecting, and a text layer, as any viewer has; these tests check both,
 * and that a box there is a box like anywhere else.
 */
import type { Page, Worker } from '@playwright/test';
import { FIXTURE_ORIGIN, expect, openPanel, test } from './fixtures';
import type { Plan } from '../../shared/payload';

const OVERLAY = 'selection-ai-overlay';
const PDF = `${FIXTURE_ORIGIN}/problem.pdf`;

const getPlan = async (panel: Page) =>
  (await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'plan:get' }))) as Plan | null;

/**
 * Arms a selection in the reader through the real path: the background's own
 * action handler, which has to recognise the reader tab and broadcast to it
 * rather than trying to inject a content script.
 */
async function armInReader(sw: Worker, reader: Page, kind: 'box' | 'freeform'): Promise<void> {
  const tabId = await reader.evaluate(async () => {
    const reply = (await chrome.runtime.sendMessage({ type: 'reader:hello' })) as { tabId?: number };
    return reply?.tabId;
  });
  expect(tabId, 'the reader never registered with the background').toBeDefined();
  // The icon arms the mode last picked from the chips, so pick it the way a student would have.
  await reader.evaluate(async (k: string) => chrome.storage.local.set({ lastSelectionKind: k }), kind);
  await sw.evaluate(async (id: number) => {
    // @ts-expect-error test-only dispatch; Chrome has no API to click the icon.
    chrome.action.onClicked.dispatch({ id });
  }, tabId!);
}

async function openReader(context: Parameters<typeof openPanel>[0], extensionId: string): Promise<Page> {
  const reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/reader.html?file=${encodeURIComponent(PDF)}`);
  await expect(reader.locator('.page canvas').first()).toBeVisible({ timeout: 30_000 });
  return reader;
}

test('the reader renders the PDF with a selectable text layer', async ({ context, extensionId }) => {
  const reader = await openReader(context, extensionId);

  await expect(reader.locator('#pages')).toHaveText('3');
  const layer = reader.locator('.page .textLayer').first();
  await expect(layer).toBeAttached({ timeout: 30_000 });
  // The text is really in the DOM, not painted into the canvas.
  await expect(layer).toContainText('Balance the equation');
  await expect(layer).toContainText('coefficient of O2');
});

test('a box selection in the reader sends its crop, like anywhere else', async ({ context, extensionId, serviceWorker }) => {
  const reader = await openReader(context, extensionId);
  const panel = await openPanel(context, extensionId);
  await reader.bringToFront();

  await armInReader(serviceWorker, reader, 'box');
  await expect(reader.locator(OVERLAY)).toHaveCount(1, { timeout: 10_000 });

  const line = reader.locator('.textLayer span', { hasText: 'Balance the equation' }).first();
  const box = (await line.boundingBox())!;
  await reader.mouse.move(box.x - 10, box.y - 10);
  await reader.mouse.down();
  await reader.mouse.move(box.x + box.width + 10, box.y + box.height + 10, { steps: 10 });
  await reader.mouse.up();

  await expect.poll(async () => (await getPlan(panel))?.parts.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  const plan = (await getPlan(panel))!;
  expect(plan.parts.map((p) => p.kind)).toEqual(['image']);
});

test('the reader scrolls while a selection is armed, though its scroller is not the window', async ({ context, extensionId, serviceWorker }) => {
  const reader = await openReader(context, extensionId);
  await reader.bringToFront();
  await armInReader(serviceWorker, reader, 'box');
  await expect(reader.locator(`${OVERLAY} .bar`)).toBeVisible({ timeout: 10_000 });

  // The reader paginates inside #viewer; window.scrollY never moves here, so
  // forwarding the wheel to the window alone would leave the page frozen.
  const before = await reader.evaluate(() => document.getElementById('viewer')!.scrollTop);
  await reader.mouse.move(500, 400);
  await reader.mouse.wheel(0, 800);
  await expect
    .poll(async () => reader.evaluate(() => document.getElementById('viewer')!.scrollTop))
    .toBeGreaterThan(before + 100);
  await expect(reader.locator(`${OVERLAY} .bar`)).toBeVisible();
});
