/**
 * The toolbar flow: one click arms a selection and dims the page a little,
 * the bar carries the controls (each with a tooltip that waits a moment), the
 * cursor tooltip comes up once the pointer has rested, a drawn box can be
 * adjusted before Send, the page still scrolls, the bar itself is never
 * selectable, and its ✕ finishes the chat, closing the panel too.
 */
import type { Page, Worker } from '@playwright/test';
import { FIXTURE_ORIGIN, dragBox, expect, openPanel, setSettings, sidePanelCount, tabIdFor, test } from './fixtures';
import type { Plan } from '../../shared/payload';

const OVERLAY = 'selection-ai-overlay';
const BAR = `${OVERLAY} .bar`;
const TIP = `${OVERLAY} .tip`;
const HINT = `${OVERLAY} .hint`;

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

/** Waits for a CSS transition to finish, so boxes are not measured in flight. */
async function settled(page: Page, selector: string): Promise<void> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const box = await page.locator(selector).boundingBox();
        const height = box?.height ?? -1;
        const stable = height === last;
        last = height;
        return stable;
      },
      { intervals: [80, 80, 80, 80, 80, 80], timeout: 4000 },
    )
    .toBe(true);
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
  // Both modes are on offer, in the bar's order.
  await expect(bar.locator('.chip')).toHaveText(['Box', 'Freeform']);
  await expect(bar.locator('.chip[data-kind="freeform"]')).toBeEnabled();
  await expect(bar.locator('.close')).toBeVisible();
  await expect(bar.locator('.ask')).toBeHidden();
  await expect(bar.locator('.gear')).toBeVisible();
  await expect(bar.locator('.say')).toHaveText('Drag over an area');

  // The bar sits near the bottom of the viewport, out of the reading line.
  const box = (await bar.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y + box.height).toBeGreaterThan(viewport.height * 0.7);

  // Nothing follows the cursor until it has rested over the page a moment.
  await expect(page.locator(TIP)).toBeHidden();

  // By default the answer panel waits for the selection, so it does not
  // narrow the page while the student is still choosing what to select.
  expect(await sidePanelCount(serviceWorker)).toBe(0);
});

test('armed, the page dims a little; while drawing, only outside the box', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  const backdrop = page.locator(`${OVERLAY} .backdrop`);
  const fill = () => backdrop.evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect.poll(fill).toBe('rgba(20, 20, 19, 0.26)');

  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(300, 200, { steps: 4 });
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'drawing');
  // The box's own shadow dims around it; inside, the page shows as it is.
  expect(await fill()).toBe('rgba(0, 0, 0, 0)');
  expect(await page.locator(`${OVERLAY} .box`).evaluate((el) => getComputedStyle(el).boxShadow)).toContain('rgba(20, 20, 19, 0.26)');
  await page.mouse.up();

  // Sent: nothing of the selection is left on the page, dim included.
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'ready', { timeout: 15_000 });
  await expect(backdrop).toHaveCount(0);

  // Switching modes swaps the surface within one frame: no frame shows the
  // page undimmed, and the new surface does not fade in again.
  await page.locator(`${BAR} .chip[data-kind="box"]`).click();
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'armed');
  // Sampled every frame from just before a real click until well after it.
  await page.evaluate(() => {
    const root = document.querySelector('selection-ai-overlay')!.shadowRoot!;
    const seen = { gaps: 0, frames: 0 };
    (window as unknown as { __modeSwap: typeof seen }).__modeSwap = seen;
    const sample = () => {
      if (!root.querySelector('.backdrop.interactive:not(.leaving)')) seen.gaps++;
      if (++seen.frames < 45) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.locator(`${BAR} .chip[data-kind="freeform"]`).click();
  await page.waitForFunction(() => (window as unknown as { __modeSwap: { frames: number } }).__modeSwap.frames >= 45);
  expect(await page.evaluate(() => (window as unknown as { __modeSwap: { gaps: number } }).__modeSwap.gaps)).toBe(0);
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'armed');
  await expect(page.locator(`${OVERLAY} .backdrop.steady`)).toHaveCount(1);
});

test('the chosen mode shows its name; the others are icons with a tooltip that waits', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  const box = page.locator(`${BAR} .chip[data-kind="box"]`);
  await expect(box.locator('.label')).toBeVisible();
  await expect(page.locator(`${BAR} .chip[data-kind="freeform"] .label`)).toBeHidden();

  // Hovering the chosen one keeps it readable: light text on its pill.
  await box.hover();
  const { color, background } = await box.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, background: s.backgroundColor };
  });
  expect(color).toBe('rgb(245, 244, 239)');
  expect(background).not.toBe('rgba(0, 0, 0, 0)');
  // Off the bar for a moment, so the next tooltip starts cold.
  await page.mouse.move(200, 120);
  await page.waitForTimeout(600);

  // A tooltip comes up only once the pointer has rested on a control.
  await page.locator(`${BAR} .chip[data-kind="freeform"]`).hover();
  await page.waitForTimeout(150);
  await expect(page.locator(HINT)).toBeHidden();
  await expect(page.locator(HINT)).toBeVisible();
  await expect(page.locator(HINT)).toHaveText('Freeform');
  // Above the control, not over it.
  const hint = (await page.locator(HINT).boundingBox())!;
  const chip = (await page.locator(`${BAR} .chip[data-kind="freeform"]`).boundingBox())!;
  expect(hint.y + hint.height).toBeLessThanOrEqual(chip.y);
  // Away from the bar, it goes.
  await page.mouse.move(200, 200);
  await expect(page.locator(HINT)).toBeHidden();

  // Then the cursor's own: what to do here, once the pointer has rested.
  await page.mouse.move(220, 210);
  await expect(page.locator(TIP)).toBeVisible();
  await expect(page.locator(TIP)).toHaveText('Drag to select');
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
  await page.mouse.move(target.x + 130, target.y + 70);
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText('Escto cancel');
  await expect(tip.locator('kbd')).toHaveText('Esc');
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

test('the X finishes: the bar goes and the answer panel closes', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const panel = await openPanel(context, extensionId);
  await expect(panel.locator('.panel')).toBeVisible();
  await armed(serviceWorker, page);

  const closed = panel.waitForEvent('close', { timeout: 10_000 });
  await page.locator(`${BAR} .close`).click();
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await closed;
  expect(panel.isClosed()).toBe(true);
});

test('Escape before anything is selected hides the bar and the panel', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  // The panel page is a tab here; opening it after the bar would be switching tabs, which takes the bar away.
  const panel = await openPanel(context, extensionId);
  await armed(serviceWorker, page);
  await expect(page.locator(BAR)).toBeVisible({ timeout: 10_000 });

  const closed = panel.waitForEvent('close', { timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await closed;
});

test('the page’s own scripts can’t operate the bar: made-up clicks, keys and drags are ignored', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  await expect(page.locator(BAR)).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => {
    const root = document.querySelector('selection-ai-overlay')!.shadowRoot!;
    (root.querySelector('.ghost') as HTMLElement).click();
    (root.querySelector('.chip[data-kind="freeform"]') as HTMLElement).click();
    const surface = root.querySelector('.backdrop.interactive') as HTMLElement;
    for (const [type, x] of [['pointerdown', 100], ['pointermove', 300], ['pointerup', 300]] as const) {
      surface.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, clientX: x, clientY: x, pointerId: 1, isPrimary: true, button: 0, buttons: 1 }));
    }
    for (const target of [document, window]) target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    (root.querySelector('.close') as HTMLElement).click();
  });
  await page.waitForTimeout(300);
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'armed');
  await expect(page.locator(`${BAR} .chip[data-kind="box"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`${BAR} .ghost`)).toHaveAttribute('aria-pressed', 'false');
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
  // The panel page is a tab here; opening it after the bar would be switching tabs, which takes the bar away.
  const panel = await openPanel(context, extensionId);
  await armed(serviceWorker, page);

  // A press and drag that begins on the bar must be inert.
  const bar = (await page.locator(BAR).boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 4);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width / 2 + 200, bar.y - 200, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'armed');
  expect(await getPlan(panel)).toBeNull();
});

test('the gear expands the bar upwards, between the controls and the notices', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  const bar = page.locator(BAR);
  const settings = page.locator(`${BAR} .settings`);

  // The bar slides in when it comes up; measure it once it has landed.
  await expect.poll(() => bar.evaluate((el) => el.getAnimations().length)).toBe(0);
  const closed = (await bar.boundingBox())!;

  await bar.locator('.gear').click();
  await expect(settings).toHaveClass(/open/);
  // Only how selecting works; who answers is picked in the panel, the mode
  // is whatever chip was used last, and the panel always opens with the
  // first selection, so none of those is a setting here.
  await expect(settings.locator('select')).toHaveCount(1);
  await expect(settings).not.toContainText('Answered by');
  await expect(settings).not.toContainText('Selection mode');
  await expect(settings).toContainText('After drawing a selection');
  await expect(settings).not.toContainText('Open the answer panel');
  await settled(page, BAR);

  const open = (await bar.boundingBox())!;
  // It grew upward: the top rose, the bottom stayed put.
  expect(open.y).toBeLessThan(closed.y);
  expect(Math.abs(open.y + open.height - (closed.y + closed.height))).toBeLessThan(4);

  // Settings sit below the control row, not above it.
  const row = (await page.locator(`${BAR} .row`).boundingBox())!;
  const panel = (await settings.boundingBox())!;
  expect(panel.y).toBeGreaterThanOrEqual(row.y + row.height - 1);

  // No secrets in page-reachable DOM.
  await expect(page.locator(`${BAR} input[type="password"]`)).toHaveCount(0);
  await expect(settings).toContainText('All settings');
});

test('the wheel is ignored once a drag has started', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page, 'long.html');

  const before = await page.evaluate(() => window.scrollY);
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(500, 400, { steps: 4 });
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(150);
  // A box is pinned to the viewport, so letting the page move under it would
  // capture something the student never framed.
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  // Let go on a box too small to count, which puts the selection back to armed.
  await page.mouse.move(402, 302, { steps: 2 });
  await page.mouse.up();
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'armed');

  // And the wheel comes back once the drag is over.
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
});

test('set to adjust, a drawn box waits, then Enter asks and the panel opens', async ({ context, extensionId, serviceWorker }) => {
  await setSettings(serviceWorker, { adjustBox: true });
  const page = await context.newPage();
  // The panel page is a tab here; opening it after the bar would be switching tabs, which takes the bar away.
  const panel = await openPanel(context, extensionId);
  await armed(serviceWorker, page);
  // Send is on the bar from the start, waiting for something to send.
  await expect(page.locator(`${BAR} .ask`)).toBeVisible();
  await expect(page.locator(`${BAR} .ask`)).toBeDisabled();

  const target = (await page.locator('#problem').boundingBox())!;
  await dragBox(page, target.x - 4, target.y - 4, target.x + target.width + 4, target.y + target.height + 4);

  // Letting go does not send anything yet: the box stays, with handles.
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'adjusting');
  await expect(page.locator(`${OVERLAY} .box.adjusting`)).toBeVisible();
  await expect(page.locator(`${OVERLAY} .handle`)).toHaveCount(8);
  await expect(page.locator(`${BAR} .ask`)).toBeEnabled();
  await expect(page.locator(`${BAR} .say`)).toHaveText('Adjust the edges, then send');
  expect(await getPlan(panel)).toBeNull();
  expect(await sidePanelCount(serviceWorker)).toBe(0);

  await page.keyboard.press('Enter');
  await expect.poll(async () => (await getPlan(panel))?.parts.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  const plan = (await getPlan(panel))!;
  expect(plan.parts.map((p) => p.kind)).toContain('image');

  // Enter is a real gesture, so the panel opens on it and nothing is left
  // nagging the student for a click.
  await expect.poll(async () => sidePanelCount(serviceWorker), { timeout: 10_000 }).toBe(1);
  await expect
    .poll(async () => serviceWorker.evaluate(async () => chrome.action.getBadgeText({})), { timeout: 10_000 })
    .toBe('');
});

test('dragging a corner resizes the box, and Ask sends the resized one', async ({ context, extensionId, serviceWorker }) => {
  await setSettings(serviceWorker, { adjustBox: true });
  const page = await context.newPage();
  // The panel page is a tab here; opening it after the bar would be switching tabs, which takes the bar away.
  const panel = await openPanel(context, extensionId);
  await armed(serviceWorker, page);

  await dragBox(page, 100, 100, 300, 200);
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'adjusting');
  // Pull the bottom-right corner out, then nudge the whole box.
  await dragBox(page, 300, 200, 360, 260);
  await dragBox(page, 200, 150, 220, 160);
  const drawn = await page.locator(`${OVERLAY} .box`).evaluate((el) => ({ left: el.style.left, width: el.style.width }));
  expect(drawn).toEqual({ left: '120px', width: '260px' });

  await page.locator(`${BAR} .ask`).click();
  await expect.poll(async () => (await getPlan(panel))?.selection.kind ?? null, { timeout: 15_000 }).toBe('box');
  expect((await getPlan(panel))!.selection.rect).toEqual({ x: 120, y: 110, width: 260, height: 160 });
});

test('set to adjust, a freeform outline waits too, and Send sends it', async ({ context, extensionId, serviceWorker }) => {
  await setSettings(serviceWorker, { adjustBox: true });
  const page = await context.newPage();
  // The panel page is a tab here; opening it after the bar would be switching tabs, which takes the bar away.
  const panel = await openPanel(context, extensionId);
  await armed(serviceWorker, page);
  await page.locator(`${BAR} .chip[data-kind="freeform"]`).click();
  await expect(page.locator(`${BAR} .chip[data-kind="freeform"]`)).toHaveAttribute('aria-pressed', 'true');

  const loop = async (cx: number, cy: number, r: number) => {
    await page.mouse.move(cx + r, cy);
    await page.mouse.down();
    for (let i = 1; i <= 24; i++) await page.mouse.move(cx + r * Math.cos((i / 24) * 2 * Math.PI), cy + r * Math.sin((i / 24) * 2 * Math.PI));
    await page.mouse.up();
  };
  await loop(200, 200, 60);
  // Kept on screen, not sent.
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'adjusting');
  await expect(page.locator(`${OVERLAY} .lasso.kept`)).toHaveCount(1);
  await expect(page.locator(`${BAR} .say`)).toHaveText('Draw again to redo, or send');
  expect(await getPlan(panel)).toBeNull();

  // Drawing again replaces it; Send sends the new one.
  await loop(400, 260, 50);
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'adjusting');
  await page.locator(`${BAR} .ask`).click();
  await expect.poll(async () => (await getPlan(panel))?.selection.kind ?? null, { timeout: 15_000 }).toBe('freeform');
  const rect = (await getPlan(panel))!.selection.rect;
  expect(Math.round(rect.x + rect.width / 2)).toBeGreaterThan(380);
});

test('Escape while adjusting cancels the whole selection', async ({ context, extensionId, serviceWorker }) => {
  await setSettings(serviceWorker, { adjustBox: true });
  const page = await context.newPage();
  // The panel page is a tab here; opening it after the bar would be switching tabs, which takes the bar away.
  const panel = await openPanel(context, extensionId);
  await armed(serviceWorker, page);

  await dragBox(page, 100, 100, 300, 200);
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'adjusting');
  // Nothing selected yet, so Escape means never mind: the bar and the panel go.
  const closed = panel.waitForEvent('close', { timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator(OVERLAY)).toHaveCount(0);
  await closed;
});

test('by default, letting go sends the box straight to the panel', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  // The panel page is a tab here; opening it after the bar would be switching tabs, which takes the bar away.
  const panel = await openPanel(context, extensionId);
  await armed(serviceWorker, page);

  await dragBox(page, 100, 100, 300, 200);
  // No adjusting step: the plan lands, the panel opens, and the bar waits for more.
  await expect.poll(async () => (await getPlan(panel))?.selection.kind ?? null, { timeout: 15_000 }).toBe('box');
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'ready');
  expect((await getPlan(panel))!.selection.rect).toEqual({ x: 100, y: 100, width: 200, height: 100 });
  await expect.poll(async () => sidePanelCount(serviceWorker), { timeout: 10_000 }).toBe(1);
});

test('the wheel is ignored while a drawn box waits to be adjusted', async ({ context, serviceWorker }) => {
  await setSettings(serviceWorker, { adjustBox: true });
  const page = await context.newPage();
  await armed(serviceWorker, page, 'long.html');

  const before = await page.evaluate(() => window.scrollY);
  await dragBox(page, 200, 200, 400, 300);
  await expect(page.locator(OVERLAY)).toHaveAttribute('data-state', 'adjusting');
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test('the real side panel closes from the X too', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  const target = (await page.locator('#problem').boundingBox())!;
  await dragBox(page, target.x - 4, target.y - 4, target.x + target.width + 4, target.y + target.height + 4);
  await expect.poll(async () => sidePanelCount(serviceWorker), { timeout: 10_000 }).toBe(1);

  // Arm again, then close everything from the bar.
  await clickToolbar(serviceWorker, `${FIXTURE_ORIGIN}/text.html`);
  await expect(page.locator(BAR)).toBeVisible({ timeout: 10_000 });
  await page.locator(`${BAR} .close`).click();
  await expect.poll(async () => sidePanelCount(serviceWorker), { timeout: 10_000 }).toBe(0);
});

test('when Chrome refuses the panel, the page offers a click that opens it', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);

  // Drive the fallback directly; the refusal itself cannot be provoked here.
  await serviceWorker.evaluate(async (u: string) => {
    const [tab] = await chrome.tabs.query({ url: u });
    await chrome.tabs.sendMessage(tab!.id!, { type: 'panel:needs-click' });
  }, `${FIXTURE_ORIGIN}/text.html`);

  // The yellow tooltip at the top of the page, with a button to open it.
  const tip = page.locator('selection-ai-tooltip .sai-tip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Your answer is ready.');
  const box = (await tip.boundingBox())!;
  expect(box.y).toBeLessThan(40);
  await tip.locator('button', { hasText: 'Show it' }).click();
  await expect(page.locator('selection-ai-tooltip')).toHaveCount(0);
});

test('the icon brings up only the bar; the panel opens with the first selection', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  await page.waitForTimeout(300);
  expect(await sidePanelCount(serviceWorker)).toBe(0);

  const target = (await page.locator('#problem').boundingBox())!;
  await dragBox(page, target.x - 4, target.y - 4, target.x + target.width + 4, target.y + target.height + 4);
  // The drag is the gesture that opens it.
  await expect.poll(async () => sidePanelCount(serviceWorker), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => serviceWorker.evaluate(async () => chrome.action.getBadgeText({}))).toBe('');
});

test('the main shortcut is the icon\'s own shortcut, Alt+Shift+S', async ({ serviceWorker }) => {
  const commands = await serviceWorker.evaluate(async () => chrome.commands.getAll());
  const main = commands.find((c) => c.name === '_execute_action');
  expect(main?.shortcut).toBe('Alt+Shift+S');
  // Every mode can have a shortcut of its own, unbound until the student
  // picks one: every default we could ship collides with some browser.
  const names = commands.map((c) => c.name).sort();
  expect(names).toEqual(['_execute_action', 'select-box', 'select-freeform']);
  for (const c of commands.filter((c) => c.name !== '_execute_action')) expect(c.shortcut, c.name).toBe('');
});

test('the icon starts the mode last picked from the chips', async ({ context, serviceWorker }) => {
  const page = await context.newPage();
  await armed(serviceWorker, page);
  await expect(page.locator(`${BAR} .chip[data-kind="box"]`)).toHaveAttribute('aria-pressed', 'true');

  await page.locator(`${BAR} .chip[data-kind="freeform"]`).click();
  await expect(page.locator(`${BAR} .chip[data-kind="freeform"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator(OVERLAY)).toHaveCount(0);

  // Next time, the icon picks up where the student left off.
  await expect.poll(async () => serviceWorker.evaluate(async () => (await chrome.storage.local.get('lastSelectionKind')).lastSelectionKind)).toBe('freeform');
  await clickToolbar(serviceWorker, `${FIXTURE_ORIGIN}/text.html`);
  await expect(page.locator(`${BAR} .chip[data-kind="freeform"]`)).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
});
