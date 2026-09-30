/**
 * Loads the unpacked extension, opens a fixture page, draws a box with the
 * content script, and checks the plan the background produced and the
 * conversation the panel shows. Runs against the mock provider, so it costs
 * nothing.
 */
import type { Page, Worker } from '@playwright/test';
import {
  FIXTURE_ORIGIN,
  boxAndAsk,
  closeSidePanels,
  currentChat,
  expect,
  openPanel,
  savedChats,
  setSettings,
  startSelection,
  tabIdFor,
  test,
} from './fixtures';
import type { Plan } from '../../shared/payload';

const getPlan = async (panel: Page, tabId?: number) =>
  (await panel.evaluate(async (id) => chrome.runtime.sendMessage({ type: 'plan:get', tabId: id }), tabId)) as Plan | null;

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
  // After the capture the bar comes back, waiting for the next selection:
  // nothing is armed over the page.
  await expect(page.locator('selection-ai-overlay')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('selection-ai-overlay .backdrop.interactive')).toHaveCount(0);
});

test('the panel holds a conversation: a first answer, then a follow-up on the same selection', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const page = await context.newPage();
  const { url, tabId } = await openFixture(page, serviceWorker, 'katex.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', url);
  await boxAround(page, panel, '#problem', tabId);

  // The selection sits at the top of the panel, labelled by kind, with no
  // token counts; the big question box starts empty, ready to type into.
  const card = panel.getByTestId('selection');
  await expect(card).toBeVisible();
  await expect(panel.getByTestId('selection-kind')).toHaveText('Box');
  await expect(card).not.toContainText('tok');
  await expect(card).not.toContainText(/attached/i);
  await expect(panel.locator('.selection-image')).toBeVisible();
  const box = panel.locator('.composer textarea');
  await expect(box).toHaveValue('');
  // Focused and ready to type into (the panel tab is not the active one here,
  // so check the document's focus rather than the window's).
  expect(await box.evaluate((el) => document.activeElement === el)).toBe(true);
  const send = panel.locator('.composer .send');
  await expect(send).toHaveText(/Send/);
  // Nothing to send until something is typed (or a macro is picked).
  await expect(send).toBeDisabled();
  await box.fill('Explain this step by step.');
  await expect(send).toBeEnabled();

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

  // The background owns the chat, so it is all in storage, in order.
  const chat = (await currentChat(panel))!;
  expect(chat.items.map((i) => i.kind)).toEqual(['selection', 'user', 'assistant', 'user', 'assistant']);
  // The first question carried the selection; the follow-up carried nothing new.
  expect(chat.items[1]!.selections).toEqual([chat.items[0]!.id]);
  expect(chat.items[3]!.selections).toEqual([]);
  // The selection is shown once, however long the chat gets.
  await expect(panel.getByTestId('selection')).toHaveCount(1);
});

test('a macro fills the box with its prompt and sends it', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const { url, tabId } = await openFixture(page, serviceWorker, 'text.html');
  const panel = await openPanel(context, extensionId);
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
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', url);
  await boxAround(page, panel, '#problem', tabId);

  await expect(panel.locator('.composer textarea')).toHaveValue('Solve it.');
  await expect(panel.locator('.macros .macro')).toHaveText(['ELI5']);
  await panel.locator('.macros .macro').click();
  await expect(panel.locator('.turn.user').first()).toHaveText("Explain it like I'm five.");
});

test('the bar’s ✕ finishes the chat; it stays in the menu and opens again from there', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const page = await context.newPage();
  const { url } = await openFixture(page, serviceWorker, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', url);
  await boxAround(page, panel, '#problem');

  await panel.locator('.macros .macro', { hasText: 'Explain' }).click();
  await expect(panel.locator('.turn.assistant').first()).toHaveAttribute('data-streaming', 'false', { timeout: 25_000 });
  // Named after the page the selection came from.
  const title = await page.title();
  await expect(panel.getByTestId('chat-title')).toHaveText(title);

  // ✕ on the bar: the bar goes, the panel closes, the chat is finished.
  const closed = panel.waitForEvent('close', { timeout: 10_000 });
  await page.locator('selection-ai-overlay .bar .close').click();
  await closed;
  await expect(page.locator('selection-ai-overlay')).toHaveCount(0);
  await expect.poll(async () => serviceWorker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('current:')).length)).toBe(0);

  // The next selection starts a new chat…
  const again = await openPanel(context, extensionId);
  await expect(again.getByTestId('empty')).toBeVisible();
  await expect(again.getByTestId('chat-title')).toHaveText('New chat');
  await expect(again.locator('.turn')).toHaveCount(0);

  // …and the old one is in the menu.
  await again.getByTestId('menu').click();
  const rows = again.getByTestId('chat-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(title);
  await rows.first().locator('.chat-open').click();
  await expect(again.getByTestId('chat-menu')).toHaveCount(0);
  await expect(again.locator('.turn.user')).toHaveCount(1);
  await expect(again.locator('.turn.assistant')).toContainText('Mock answer');
  expect((await savedChats(serviceWorker)).length).toBe(1);
});

test('selections from different pages go into the same chat, and one question carries them all', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const a = await context.newPage();
  const b = await context.newPage();
  const first = await openFixture(a, serviceWorker, 'text.html');
  const second = await openFixture(b, serviceWorker, 'table.html');
  const panel = await openPanel(context, extensionId);

  await a.bringToFront();
  await startSelection(serviceWorker, 'box', first.url);
  await boxAround(a, panel, '#problem', first.tabId);
  await b.bringToFront();
  await startSelection(serviceWorker, 'box', second.url);
  await boxAround(b, panel, 'table', second.tabId);

  // Both in one chat, named after the first page. That page is not repeated
  // above its own selection; a selection from another page says which.
  const cards = panel.getByTestId('selection');
  await expect(cards).toHaveCount(2);
  await expect(panel.getByTestId('chat-title')).toHaveText(await a.title());
  await expect(cards.nth(0).getByTestId('selection-page')).toHaveCount(0);
  await expect(cards.nth(1).getByTestId('selection-page')).toHaveText(await b.title());
  await expect(panel.locator('.composer textarea')).toHaveAttribute('placeholder', 'Ask about these selections…');
  // Not asked about yet, so either can still be taken back.
  await expect(panel.getByTestId('selection-remove')).toHaveCount(2);

  await panel.locator('.macros .macro', { hasText: 'Explain' }).click();
  const answer = panel.locator('.turn.assistant').first();
  await expect(answer).toHaveAttribute('data-streaming', 'false', { timeout: 25_000 });
  // One question, both screenshots.
  await expect(answer).toContainText('2 part(s)');
  const chat = (await currentChat(panel))!;
  expect(chat.items.map((i) => i.kind)).toEqual(['selection', 'selection', 'user', 'assistant']);
  expect(chat.items[2]!.selections).toEqual([chat.items[0]!.id, chat.items[1]!.id]);
  // Asked about, so they are part of the conversation now.
  await expect(panel.getByTestId('selection-remove')).toHaveCount(0);

  // A third selection joins the same chat and goes with the next question alone.
  await a.bringToFront();
  await startSelection(serviceWorker, 'box', first.url);
  await boxAround(a, panel, '#problem', first.tabId);
  await expect(cards).toHaveCount(3);
  await expect(panel.locator('.composer textarea')).toHaveAttribute('placeholder', 'Ask about the new selection…');
  await panel.locator('.macros .macro', { hasText: 'Hint' }).click();
  await expect(panel.locator('.turn.assistant').nth(1)).toContainText('1 part(s)', { timeout: 25_000 });
  await expect(panel.locator('.turn.assistant').nth(1)).toContainText('plus 2 earlier selection(s)');
});

test('a selection can be taken back before it is asked about', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const { url } = await openFixture(page, serviceWorker, 'text.html');
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', url);
  await boxAround(page, panel, '#problem');
  await expect(panel.getByTestId('selection')).toHaveCount(1);

  await panel.getByTestId('selection-remove').click();
  await expect(panel.getByTestId('selection')).toHaveCount(0);
  await expect(panel.getByTestId('empty')).toBeVisible();
  // An empty chat is not kept.
  await expect.poll(async () => (await savedChats(serviceWorker)).length).toBe(0);
});

test('a text selection shows the text it captured', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const { url, tabId } = await openFixture(page, serviceWorker, 'text.html');
  const panel = await openPanel(context, extensionId);
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
  const closed = panel.waitForEvent('close', { timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('selection-ai-overlay')).toHaveCount(0);
  // Nothing was selected, so the bar and the panel went, leaving no chat behind.
  await closed;
  expect(await serviceWorker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith('current:')).length)).toBe(0);
});
