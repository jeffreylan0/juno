/**
 * Loads the unpacked extension, opens a fixture page, draws a box with the
 * content script, and checks the plan the background produced and the
 * conversation the panel shows. Runs against the mock provider, so it costs
 * nothing.
 */
import type { Page, Worker } from '@playwright/test';
import { FIXTURE_ORIGIN, boxAndAsk, expect, openPanel, setSettings, startSelection, tabIdFor, test } from './fixtures';
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

test('a box selection sends its screenshot and nothing read off the page', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const { url } = await openFixture(page, serviceWorker, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront(); // captureVisibleTab grabs the window's active tab
  await startSelection(serviceWorker, 'box', url);

  const plan = await boxAround(page, panel, '#problem');

  expect(plan.selection.kind).toBe('box');
  expect(plan.route).toBe('large');
  // Reading the screenshot is the model's job: no page text rides along.
  expect(plan.parts.map((p) => p.kind)).toEqual(['image']);

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

  // The selection sits at the top of the panel, labelled by kind, with no
  // token counts; the short default prompt waits in a big question box.
  const card = panel.getByTestId('selection');
  await expect(card).toBeVisible();
  await expect(panel.getByTestId('selection-kind')).toHaveText('Box');
  await expect(card).not.toContainText('tok');
  await expect(card).not.toContainText(/attached/i);
  await expect(panel.locator('.selection-image')).toBeVisible();
  const box = panel.locator('.composer textarea');
  await expect(box).toHaveValue('Explain this step by step.');
  // Focused and ready to type into (the panel tab is not the active one here,
  // so check the document's focus rather than the window's).
  expect(await box.evaluate((el) => document.activeElement === el)).toBe(true);
  const send = panel.locator('.composer .send');
  await expect(send).toHaveText(/Send/);

  // The selection is above the conversation, and the box is below it.
  const cardTop = (await card.boundingBox())!.y;
  const boxTop = (await box.boundingBox())!.y;
  expect(cardTop).toBeLessThan(120);
  expect(boxTop).toBeGreaterThan(cardTop);

  await send.click();
  const answers = panel.locator('.turn.assistant');
  await expect(answers).toHaveCount(1);
  await expect(answers.first()).toHaveAttribute('data-streaming', 'false', { timeout: 25_000 });
  await expect(answers.first()).toContainText('Mock answer');
  // Students never see model or token lines by default.
  await expect(panel.locator('.usage')).toHaveCount(0);

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
  // The selection is shown once, at the top, however long the thread gets.
  await expect(panel.getByTestId('selection')).toHaveCount(1);
});

test('a macro fills the box with its prompt and sends it', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const { url, tabId } = await openFixture(page, serviceWorker, 'text.html');
  const panel = await openPanel(context, extensionId, tabId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', url);
  await boxAround(page, panel, '#problem', tabId);

  const macros = panel.locator('.macros .macro');
  await expect(macros).toHaveText(['Explain', 'Hint', 'Check']);
  // The old mode tabs are gone from the top of the panel.
  await expect(panel.locator('[role="tab"]')).toHaveCount(0);

  await macros.filter({ hasText: 'Hint' }).click();
  await expect(panel.locator('.turn.user').first()).toHaveText('Give me a hint for the next step, not the answer.');
  await expect(panel.locator('.turn.assistant').first()).toHaveAttribute('data-streaming', 'false', { timeout: 25_000 });
  await expect(panel.locator('.composer textarea')).toHaveValue('');

  // A macro works for follow-ups too.
  await macros.filter({ hasText: 'Check' }).click();
  await expect(panel.locator('.turn.user').nth(1)).toHaveText('Check my work and point to the first mistake.');
  await expect(panel.locator('.turn.assistant').nth(1)).toContainText('Mock follow-up', { timeout: 25_000 });
});

test('macros and the default prompt come from settings', async ({ context, extensionId, serviceWorker }) => {
  await setSettings(serviceWorker, {
    defaultPrompt: 'Solve it.',
    macros: [{ id: 'eli5', name: 'ELI5', prompt: "Explain it like I'm five." }],
  });
  const page = await context.newPage();
  const { url, tabId } = await openFixture(page, serviceWorker, 'text.html');
  const panel = await openPanel(context, extensionId, tabId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', url);
  await boxAround(page, panel, '#problem', tabId);

  await expect(panel.locator('.composer textarea')).toHaveValue('Solve it.');
  await expect(panel.locator('.macros .macro')).toHaveText(['ELI5']);
  await panel.locator('.macros .macro').click();
  await expect(panel.locator('.turn.user').first()).toHaveText("Explain it like I'm five.");
});

test('the conversation survives the panel closing and reopening', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const { url, tabId } = await openFixture(page, serviceWorker, 'text.html');
  let panel = await openPanel(context, extensionId, tabId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', url);
  await boxAround(page, panel, '#problem', tabId);

  await panel.locator('.composer .send').click();
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
  await panelA.locator('.composer .send').click();
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
  await expect(panel.getByTestId('selection-kind')).toHaveText('Text');
  await expect(panel.getByTestId('selection-text')).toContainText('Balance the equation');
  // Text is sent as text alone; no screenshot rides along.
  await expect(panel.locator('.selection-image')).toHaveCount(0);
  expect((await getPlan(panel, tabId))!.parts.map((p) => p.kind)).toEqual(['text']);
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
