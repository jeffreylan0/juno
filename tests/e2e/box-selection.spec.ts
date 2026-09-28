/**
 * Loads the unpacked extension, opens a fixture page, draws a box with the
 * content script, and checks the plan the background produced and the
 * conversation the panel shows. Runs against the mock provider, so it costs
 * nothing.
 */
import type { Page, Worker } from '@playwright/test';
import { FIXTURE_ORIGIN, boxAndAsk, expect, openPanel, startSelection, tabIdFor, test } from './fixtures';
import type { Plan } from '../../shared/payload';

const getPlan = async (panel: Page, tabId?: number) =>
  (await panel.evaluate(async (id) => chrome.runtime.sendMessage({ type: 'plan:get', tabId: id }), tabId)) as Plan | null;

/** The stored conversation for a tab, read the way the panel reads it. */
const getChat = async (panel: Page, tabId: number) =>
  (await panel.evaluate(async (id) => (await chrome.storage.session.get(`chat:${id}`))[`chat:${id}`], tabId)) as
    | { planId: string; turns: { role: string; text: string; streaming?: boolean; error?: string }[] }
    | undefined;

/** Draws a box around `selector` on `page`, asks, and waits for the plan. */
async function boxAround(page: Page, panel: Page, selector: string, tabId?: number): Promise<Plan> {
  await boxAndAsk(page, selector);
  await expect.poll(async () => (await getPlan(panel, tabId))?.parts.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  return (await getPlan(panel, tabId))!;
}

async function openFixture(page: Page, sw: Worker, path: string): Promise<{ url: string; tabId: number }> {
  const url = `${FIXTURE_ORIGIN}/${path}`;
  await page.goto(url);
  return { url, tabId: await tabIdFor(sw, url) };
}

test('a box selection produces a plan with an image part and the visible text', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const { url } = await openFixture(page, serviceWorker, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront(); // captureVisibleTab grabs the window's active tab
  await startSelection(serviceWorker, 'box', url);

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

test('the panel holds a conversation: a first answer, then a follow-up on the same selection', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const page = await context.newPage();
  const { url, tabId } = await openFixture(page, serviceWorker, 'katex.html');
  const panel = await openPanel(context, extensionId, tabId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', url);
  await boxAround(page, panel, '#problem', tabId);

  // Before anything is sent, the selection waits above the composer with the
  // mode's default prompt ready to edit.
  await expect(panel.getByTestId('selection')).toHaveClass(/pending/);
  await expect(panel.locator('.selection-image')).toBeVisible();
  const box = panel.locator('.composer textarea');
  await expect(box).toHaveValue(/step by step/);

  await panel.locator('.composer button[type="submit"]').click();
  const answers = panel.locator('.turn.assistant');
  await expect(answers).toHaveCount(1);
  await expect(answers.first()).toHaveAttribute('data-streaming', 'false', { timeout: 25_000 });
  await expect(answers.first()).toContainText('Mock answer');
  // The selection now belongs to the opening message, like an attachment.
  await expect(panel.locator('.turn.user').first().getByTestId('selection')).toHaveClass(/sent/);
  await expect(panel.locator('.selection.pending')).toHaveCount(0);

  await expect(box).toHaveAttribute('placeholder', 'Ask a follow-up…');
  await box.fill('What does the minus sign mean?');
  await box.press('Enter');
  await expect(answers).toHaveCount(2);
  await expect(answers.nth(1)).toHaveAttribute('data-streaming', 'false', { timeout: 25_000 });
  await expect(answers.nth(1)).toContainText('Mock follow-up');
  await expect(answers.nth(1)).toContainText('What does the minus sign mean?');

  // The background owns the thread, so it is all in storage, in order.
  const chat = (await getChat(panel, tabId))!;
  expect(chat.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  // Only the opening message shows the selection.
  await expect(panel.getByTestId('selection')).toHaveCount(1);
});

test('the conversation survives the panel closing and reopening', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const { url, tabId } = await openFixture(page, serviceWorker, 'text.html');
  let panel = await openPanel(context, extensionId, tabId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', url);
  await boxAround(page, panel, '#problem', tabId);

  await panel.locator('.composer button[type="submit"]').click();
  await expect(panel.locator('.turn.assistant').first()).toHaveAttribute('data-streaming', 'false', { timeout: 25_000 });
  await panel.close();

  panel = await openPanel(context, extensionId, tabId);
  await expect(panel.locator('.turn.user')).toHaveCount(1);
  await expect(panel.locator('.turn.assistant')).toContainText('Mock answer');
});

test('each tab keeps its own selection and conversation', async ({ context, extensionId, serviceWorker }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const first = await openFixture(a, serviceWorker, 'text.html');
  const second = await openFixture(b, serviceWorker, 'table.html');
  const panelA = await openPanel(context, extensionId, first.tabId);
  const panelB = await openPanel(context, extensionId, second.tabId);

  await a.bringToFront();
  await startSelection(serviceWorker, 'box', first.url);
  await boxAround(a, panelA, '#problem', first.tabId);

  // The second tab has nothing yet, even though the first just got a selection.
  await expect(panelB.locator('.empty')).toBeVisible();
  expect(await getPlan(panelB, second.tabId)).toBeNull();

  await b.bringToFront();
  await startSelection(serviceWorker, 'box', second.url);
  await boxAround(b, panelB, 'table', second.tabId);

  const planA = (await getPlan(panelA, first.tabId))!;
  const planB = (await getPlan(panelB, second.tabId))!;
  expect(planA.id).not.toBe(planB.id);
  expect(planA.page.url).toBe(first.url);
  expect(planB.page.url).toBe(second.url);

  // Asking in one tab leaves the other's thread untouched.
  await panelA.locator('.composer button[type="submit"]').click();
  await expect(panelA.locator('.turn.assistant')).toHaveCount(1);
  await expect(panelB.locator('.turn')).toHaveCount(0);

  // Closing a tab forgets its thread.
  await a.close();
  await expect.poll(async () => getPlan(panelB, first.tabId)).toBeNull();
  expect((await getPlan(panelB, second.tabId))?.id).toBe(planB.id);
});

test('a text selection shows the text it captured', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const { url, tabId } = await openFixture(page, serviceWorker, 'text.html');
  const panel = await openPanel(context, extensionId, tabId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'text', url);
  await expect(page.locator('selection-ai-overlay')).toHaveCount(1);

  // Select the problem sentence with a real drag, as a student would.
  const p = (await page.locator('#problem').boundingBox())!;
  await page.mouse.move(p.x + 1, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + p.width - 2, p.y + p.height / 2, { steps: 10 });
  await page.mouse.up();

  await expect.poll(async () => (await getPlan(panel, tabId))?.selection.kind ?? null, { timeout: 15_000 }).toBe('text');
  // Before this preview, a text selection produced a one-line chip and an
  // empty panel, which read as "it did not work".
  await expect(panel.getByTestId('selection-text')).toContainText('Balance the equation');
  await expect(panel.locator('.selection-image')).toHaveCount(0);
});

test('escape cancels without producing a plan', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const { url } = await openFixture(page, serviceWorker, 'table.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', url);

  await expect(page.locator('selection-ai-overlay')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('selection-ai-overlay')).toHaveCount(0);
  expect(await getPlan(panel)).toBeNull();
});
