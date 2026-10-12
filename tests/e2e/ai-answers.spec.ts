/**
 * Real-AI answers with the student's own key, end to end: the extension's
 * request to the vendor, the streamed answer rendered with KaTeX, and errors
 * that say what to do. The vendor is played by a Playwright route, so the
 * test is free and offline; the request is still the real one the worker makes.
 */
import type { Page, Route, Worker } from '@playwright/test';
import { FIXTURE_ORIGIN, boxAndAsk, expect, openPanel, setSettings, startSelection, tabIdFor, test } from './fixtures';

const ANTHROPIC = 'https://api.anthropic.com/v1/**';
const MESSAGES = 'https://api.anthropic.com/v1/messages';

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

const ANSWER = sse([
  { type: 'message_start', message: { usage: { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Read: the integral of x squared from 0 to 1.\n\n' } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Integrate: $\\int_0^1 x^2\\,dx = \\tfrac{1}{3}$.\n\nAnswer: 1/3' } },
  { type: 'message_delta', usage: { output_tokens: 40 } },
  { type: 'message_stop' },
]);

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

// The panel checks the chosen AI is reachable by listing its models (free).
// A test that cares about that check routes it itself; the rest see a key
// that works.
test.beforeEach(async ({ context }) => {
  await context.route('https://api.anthropic.com/v1/models**', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ data: [] }) });
  });
});

async function useKey(sw: Worker): Promise<void> {
  await setSettings(sw, { provider: 'byok', vendor: 'anthropic' });
  await sw.evaluate(async () => chrome.storage.local.set({ keys: { anthropic: 'sk-ant-test', openai: '', session: '' } }));
}

async function selectProblem(page: Page, sw: Worker, panel: Page, url: string): Promise<void> {
  await page.bringToFront();
  await startSelection(sw, 'box', url);
  await boxAndAsk(page, '#problem');
  await expect(panel.getByTestId('selection')).toBeVisible({ timeout: 15_000 });
}

test('with a key, the answer streams from Claude and renders its maths', async ({ context, extensionId, serviceWorker }) => {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  await context.route(MESSAGES, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    requests.push({ url: req.url(), headers: req.headers(), body: req.postDataJSON() as Record<string, unknown> });
    await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: ANSWER });
  });
  await useKey(serviceWorker);

  const page = await context.newPage();
  const url = `${FIXTURE_ORIGIN}/katex.html`;
  await page.goto(url);
  const panel = await openPanel(context, extensionId);
  await expect(panel.getByTestId('model-picker')).toHaveValue('anthropic:auto');
  // Connected: no placeholder notice, nothing to warn about.
  await expect(panel.getByTestId('notice')).toHaveCount(0);
  await selectProblem(page, serviceWorker, panel, url);

  await panel.locator('.macros .macro', { hasText: 'Explain' }).click();
  const answer = panel.locator('.turn.assistant').first();
  await expect(answer).toHaveAttribute('data-streaming', 'false', { timeout: 15_000 });
  await expect(answer.locator('.what-i-read')).toContainText('the integral of x squared');
  await expect(answer.locator('.katex').first()).toBeVisible();
  await expect(answer).toContainText('Answer: 1/3');

  // The request the worker actually made.
  expect(requests).toHaveLength(1);
  const sent = requests[0]!;
  expect(sent.url).toBe('https://api.anthropic.com/v1/messages');
  expect(sent.headers['x-api-key']).toBe('sk-ant-test');
  expect(sent.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  expect(sent.body.model).toBe('claude-sonnet-5-5');
  const content = (sent.body.messages as { content: { type: string; text?: string }[] }[])[0]!.content;
  // The screenshot and the question, and nothing scraped from the page.
  expect(content.map((b) => b.type)).toEqual(['image', 'text']);
  expect(content[1]!.text).toContain('Question: Explain this step by step.');
  expect(content[1]!.text).toContain('screenshot of the area the student selected');
  expect(content[1]!.text).not.toContain('Evaluate the integral');
});

test('a rejected key says so and offers settings; an overload offers a retry that works', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  let respond: 'bad-key' | 'overloaded' | 'ok' = 'bad-key';
  await context.route(MESSAGES, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (respond === 'bad-key') {
      return route.fulfill({
        status: 401,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
      });
    }
    if (respond === 'overloaded') {
      return route.fulfill({
        status: 529,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
      });
    }
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: ANSWER });
  });
  await useKey(serviceWorker);

  const page = await context.newPage();
  const url = `${FIXTURE_ORIGIN}/katex.html`;
  await page.goto(url);
  const tabId = await tabIdFor(serviceWorker, url);
  const panel = await openPanel(context, extensionId);
  await selectProblem(page, serviceWorker, panel, url);

  await panel.locator('.composer textarea').fill('What is this?');
  await panel.locator('.composer .send').click();
  const error = panel.locator('.turn.assistant .error');
  await expect(error).toContainText('Anthropic rejected the API key. Check it in Settings.');
  await expect(error).toHaveAttribute('data-code', 'bad-key');
  await expect(error.getByRole('button', { name: 'Open settings' })).toBeVisible();
  await expect(error.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  // The notice above the macros says so too, until an answer gets through.
  await expect(panel.locator('[data-testid="notice"][data-kind="bad-key"]')).toContainText('Anthropic rejected your API key.');

  respond = 'overloaded';
  await panel.locator('.composer textarea').fill('Try once more.');
  await panel.locator('.composer textarea').press('Enter');
  const second = panel.locator('.turn.assistant .error').nth(1);
  await expect(second).toContainText('overloaded');
  await expect(second.getByRole('button', { name: 'Try again' })).toBeVisible();

  respond = 'ok';
  await second.getByRole('button', { name: 'Try again' }).click();
  // The failed question is asked afresh; its error is gone, the answer is in.
  await expect(panel.locator('.turn.assistant').last()).toContainText('Answer: 1/3', { timeout: 15_000 });
  await expect(panel.locator('.turn.user').last()).toHaveText('Try once more.');
  await expect(panel.getByTestId('notice')).toHaveCount(0);
  await expect(panel.locator('.turn.assistant .error')).toHaveCount(1);
});

test('settings show only what the chosen AI needs, check a key for free, and save as you go', async ({ context, extensionId, serviceWorker }) => {
  await context.route(ANTHROPIC, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const good = req.headers()['x-api-key'] === 'sk-ant-good';
    await route.fulfill({
      status: good ? 200 : 401,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify(
        good
          ? {
              data: [
                { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', capabilities: { image_input: { supported: true } } },
                { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', capabilities: { image_input: { supported: true } } },
              ],
            }
          : { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
      ),
    });
  });

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  // Placeholder answers to start with: no key box, no server box.
  await expect(options.getByTestId('answer-placeholder')).toHaveClass(/on/);
  await expect(options.getByTestId('keys')).toHaveCount(0);
  await expect(options.getByTestId('local')).toHaveCount(0);

  // Choosing Claude shows only what Claude needs, and is saved at once.
  await options.getByTestId('answer-claude').click();
  const keys = options.getByTestId('keys');
  await expect(keys).toBeVisible();
  await expect(options.getByTestId('local')).toHaveCount(0);
  await expect(options.getByTestId('saved')).toHaveText('Saved');

  await keys.getByTestId('key-input').fill('sk-ant-bad');
  await keys.getByTestId('test-key').click();
  await expect(keys.getByTestId('key-status')).toHaveText('Anthropic rejected the API key. Check it in Settings.');

  await keys.getByTestId('key-input').fill('sk-ant-good');
  await keys.getByTestId('test-key').click();
  await expect(keys.getByTestId('key-status')).toContainText('✓ Works. 2 models.');
  await expect(keys.getByTestId('model-select').locator('option')).toHaveText([
    'Automatic — Claude Sonnet 5.5',
    'Claude Haiku 4.5',
    'Claude Sonnet 5.5',
  ]);
  await keys.getByTestId('model-select').selectOption('claude-sonnet-5-5');

  // No Save button: the choice, the key and the model are already stored.
  await expect(options.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect
    .poll(async () =>
      serviceWorker.evaluate(async () => {
        const { settings, keys } = await chrome.storage.local.get(['settings', 'keys']);
        return { provider: settings?.provider, vendor: settings?.vendor, model: settings?.modelOverride?.model, key: keys?.anthropic };
      }),
    )
    .toEqual({ provider: 'byok', vendor: 'anthropic', model: 'claude-sonnet-5-5', key: 'sk-ant-good' });

  // A local model swaps the key for a server address.
  await options.getByTestId('answer-local').click();
  await expect(options.getByTestId('keys')).toHaveCount(0);
  await expect(options.getByTestId('local')).toBeVisible();
  // And coming back to Claude keeps the model picked for it.
  await options.getByTestId('answer-claude').click();
  await expect(options.getByTestId('model-select')).toHaveValue('claude-sonnet-5-5');
});

test('the model picker beside the macros switches who answers, without a trip to settings', async ({ context, extensionId, serviceWorker }) => {
  const bodies: Record<string, unknown>[] = [];
  await context.route(MESSAGES, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: ANSWER });
  });
  // An Anthropic key but no OpenAI key.
  await serviceWorker.evaluate(async () => chrome.storage.local.set({ keys: { anthropic: 'sk-ant-test', openai: '', session: '' } }));

  const page = await context.newPage();
  const url = `${FIXTURE_ORIGIN}/katex.html`;
  await page.goto(url);
  const panel = await openPanel(context, extensionId);
  const picker = panel.getByTestId('model-picker');
  // Nothing connected yet: placeholder answers.
  await expect(picker).toHaveValue('placeholder');
  // Every major model is offered; ChatGPT's wait for a key.
  await expect(picker.locator('option[value="anthropic:claude-opus-5-5"]')).toHaveJSProperty('disabled', false);
  await expect(picker.locator('option[value="anthropic:claude-fable-5-1"]')).toHaveText('Fable 5.1');
  await expect(picker.locator('option[value="openai:gpt-6-sol"]')).toHaveJSProperty('disabled', true);
  await expect(picker.locator('option[value="openai:gpt-6-sol"]')).toHaveText('GPT-6 Sol — add key');
  await expect(picker.locator('option[value="anthropic:auto"]')).toHaveText('Claude Auto');

  await expect(panel.locator('[data-testid="notice"][data-kind="placeholder"]')).toBeVisible();
  await picker.selectOption('anthropic:claude-opus-5-5');
  await expect(panel.getByTestId('notice')).toHaveCount(0);
  await selectProblem(page, serviceWorker, panel, url);
  await panel.locator('.macros .macro', { hasText: 'Hint' }).click();
  await expect(panel.locator('.turn.assistant').first()).toContainText('Answer: 1/3', { timeout: 15_000 });
  expect(bodies[0]!.model).toBe('claude-opus-5-5');
});

test('every selection in the chat reaches the model: all new ones with the question, earlier ones in the history', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const bodies: { messages: { role: string; content: string | { type: string; text?: string }[] }[] }[] = [];
  await context.route(MESSAGES, async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    bodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: ANSWER });
  });
  await useKey(serviceWorker);

  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto(`${FIXTURE_ORIGIN}/katex.html`);
  await b.goto(`${FIXTURE_ORIGIN}/table.html`);
  const panel = await openPanel(context, extensionId);
  await selectProblem(a, serviceWorker, panel, `${FIXTURE_ORIGIN}/katex.html`);
  // On to tab B, where the icon brings the bar up again: a second selection, from another page.
  await b.bringToFront();
  await startSelection(serviceWorker, 'box', `${FIXTURE_ORIGIN}/table.html`);
  await expect(b.locator('selection-ai-overlay')).toHaveAttribute('data-state', 'armed', { timeout: 10_000 });
  await boxAndAsk(b, 'table');
  await expect(panel.getByTestId('selection')).toHaveCount(2, { timeout: 15_000 });

  await panel.locator('.macros .macro', { hasText: 'Explain' }).click();
  await expect(panel.locator('.turn.assistant').first()).toContainText('Answer: 1/3', { timeout: 15_000 });
  const first = bodies[0]!.messages;
  expect(first).toHaveLength(1);
  const opening = first[0]!.content as { type: string; text?: string }[];
  // Both screenshots, each named by its page, with the question.
  expect(opening.filter((c) => c.type === 'image')).toHaveLength(2);
  const text = opening.find((c) => c.type === 'text')!.text!;
  expect(text).toContain('The student selected 2 things');
  expect(text).toContain('Fixture: KaTeX page');
  expect(text).toContain('Fixture: table page');

  // A follow-up with nothing new selected: both screenshots still go, as the history.
  await panel.locator('.composer textarea').fill('Which one is harder?');
  await panel.locator('.composer textarea').press('Enter');
  await expect(panel.locator('.turn.assistant').nth(1)).toContainText('Answer: 1/3', { timeout: 15_000 });
  const second = bodies[1]!.messages;
  expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  expect((second[0]!.content as { type: string }[]).filter((c) => c.type === 'image')).toHaveLength(2);
  const last = second[2]!.content;
  expect(typeof last === 'string' ? last : last.map((c) => c.text ?? '').join('')).toContain('Which one is harder?');
});
