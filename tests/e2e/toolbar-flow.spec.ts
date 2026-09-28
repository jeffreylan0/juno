/**
 * The toolbar flow after the popup was removed: one click arms a selection,
 * the hint carries the mode chips and gets out of the way during a drag, and
 * the answer panel opens off the drag's own user gesture.
 */
import type { Page, Worker } from '@playwright/test';
import { FIXTURE_ORIGIN, expect, openPanel, test } from './fixtures';
import type { Plan } from '../../shared/payload';

const OVERLAY = 'selection-ai-overlay';

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

test('one toolbar click arms a box selection with the mode chips', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  const url = `${FIXTURE_ORIGIN}/text.html`;
  await page.goto(url);
  await clickToolbar(serviceWorker, url);

  await expect(page.locator(OVERLAY)).toHaveCount(1, { timeout: 10_000 });
  const hint = page.locator(`${OVERLAY} .hint`);
  await expect(hint).toBeVisible();
  await expect(hint.locator('.chip[data-kind="box"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(hint.locator('.chip[data-kind="text"]')).toBeEnabled();
  await expect(hint.locator('.chip[data-kind="element"]')).toBeDisabled();
});

test('the hint stays out of the way while dragging', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  const url = `${FIXTURE_ORIGIN}/text.html`;
  await page.goto(url);
  await clickToolbar(serviceWorker, url);
  const host = page.locator(OVERLAY);
  await expect(host).toHaveCount(1, { timeout: 10_000 });
  await expect(host).toHaveAttribute('data-hint', 'visible');

  const box = (await page.locator('#problem').boundingBox())!;
  await page.mouse.move(box.x - 4, box.y - 4);
  await page.mouse.down();
  // Moving mid-drag must not wake the hint back up.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await expect(host).toHaveAttribute('data-hint', 'faded');
  await page.mouse.move(box.x + box.width + 4, box.y + box.height + 4, { steps: 5 });
  await expect(host).toHaveAttribute('data-hint', 'faded');
  await page.mouse.up();
});

test('the chips switch mode without a round trip through the toolbar', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  const url = `${FIXTURE_ORIGIN}/text.html`;
  await page.goto(url);
  await clickToolbar(serviceWorker, url);
  await expect(page.locator(OVERLAY)).toHaveCount(1, { timeout: 10_000 });

  await page.locator(`${OVERLAY} .chip[data-kind="text"]`).click();
  await expect(page.locator(`${OVERLAY} .chip[data-kind="text"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`${OVERLAY} .hint`)).toContainText('Select text on the page');
});

/**
 * Smoke check only. Headless Chromium does not enforce the user-activation
 * rule on sidePanel.open() — I confirmed that by delaying the call 600ms and
 * watching it still succeed — so this cannot prove the gesture carries in a
 * real browser. What it does catch is the open never being attempted, or
 * failing for some other reason, and it pins the fallback's shape.
 */
test('a selection asks for the panel and does not fall back to a click', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const url = `${FIXTURE_ORIGIN}/text.html`;
  await page.goto(url);
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await clickToolbar(serviceWorker, url);
  await expect(page.locator(OVERLAY)).toHaveCount(1, { timeout: 10_000 });

  const box = (await page.locator('#problem').boundingBox())!;
  await page.mouse.move(box.x - 4, box.y - 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 4, box.y + box.height + 4, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await getPlan(panel))?.parts.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);

  // An empty badge means the background never had to fall back to asking for
  // a click. In a real browser this is the assertion that would catch Chrome
  // refusing the activation.
  const badge = await serviceWorker.evaluate(async () => chrome.action.getBadgeText({}));
  expect(badge, 'panel needed a manual click; the gesture did not carry').toBe('');
  // And nothing should be nagging the page for one.
  await expect(page.locator('selection-ai-toast')).toHaveCount(0);
});

test('when Chrome refuses the panel, the page offers a click that opens it', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  const url = `${FIXTURE_ORIGIN}/text.html`;
  await page.goto(url);
  await clickToolbar(serviceWorker, url);
  await expect(page.locator(OVERLAY)).toHaveCount(1, { timeout: 10_000 });

  // Drive the fallback directly; the refusal itself cannot be provoked here.
  await serviceWorker.evaluate(async (u: string) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await chrome.tabs.sendMessage(tab!.id!, { type: 'panel:needs-click' });
  }, url);

  const toast = page.locator('selection-ai-toast .toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Your answer is ready');
  await toast.locator('button', { hasText: 'Show it' }).click();
  await expect(page.locator('selection-ai-toast')).toHaveCount(0);
});
