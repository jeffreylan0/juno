/**
 * Accounts end to end: signing in with an emailed code on the settings page,
 * cloud storage for an account that has it (a chat going up, one coming down
 * from "another computer"), hosted answers through the Worker, signing out
 * and deleting the account. Supabase is played by tests/support's fake and
 * the Worker by a route, so nothing real is reached.
 */
import type { BrowserContext, Page, Route, Worker } from '@playwright/test';
import { FakeSupabase } from '../support/fake-supabase';
import { FIXTURE_ORIGIN, boxAndAsk, expect, openPanel, setSettings, startSelection, test } from './fixtures';

const WORKER = 'https://hosted.e2e.test';

async function serve(context: BrowserContext, fake: FakeSupabase): Promise<void> {
  await context.route(`${fake.url}/**`, async (route: Route) => {
    const r = route.request();
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(r.method()) ? undefined : (r.postDataBuffer() ?? undefined);
    const res = await fake.handle(new Request(r.url(), { method: r.method(), headers: r.headers(), body }));
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: Buffer.from(await res.arrayBuffer()) });
  });
}

async function signIn(options: Page, fake: FakeSupabase, email: string): Promise<void> {
  const account = options.getByTestId('section-account');
  await account.getByTestId('email-input').fill(email);
  await account.getByTestId('send-code').click();
  await expect(account.getByTestId('code-sent')).toContainText(email);
  await account.getByTestId('code-input').fill('000000');
  await account.getByTestId('verify-code').click();
  await expect(account.getByTestId('account-error')).toContainText("That code didn't work");
  await account.getByTestId('code-input').fill(fake.codes.get(email)!);
  await account.getByTestId('verify-code').click();
  await expect(account.getByTestId('account-email')).toHaveText(email);
}

/** A saved chat, as an earlier session would have left it. */
async function seedChat(sw: Worker, id: string, title: string): Promise<void> {
  await sw.evaluate(
    async ({ id, title }) => {
      const at = Date.now() - 60_000;
      const plan = {
        id: `p-${id}`,
        mode: 'ask',
        route: 'small',
        page: { url: `https://example.com/${id}`, title },
        selection: { kind: 'text', rect: { x: 0, y: 0, width: 1, height: 1 }, devicePixelRatio: 1 },
        parts: [{ kind: 'text', text: `problem ${id}` }],
        question: '',
      };
      await chrome.storage.local.set({
        [`chat:${id}`]: { id, title, createdAt: at, updatedAt: at, items: [{ kind: 'selection', id: `s-${id}`, at, plan }] },
        chatIndex: [{ id, title, createdAt: at, updatedAt: at, search: title.toLowerCase() }],
      });
    },
    { id, title },
  );
}

test('sign in with an emailed code; an account with cloud storage keeps chats in the cloud both ways', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const fake = new FakeSupabase();
  await serve(context, fake);
  await seedChat(serviceWorker, 'here-1', 'Stoichiometry homework');

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html#account`);
  const account = options.getByTestId('section-account');
  await expect(account.getByTestId('sign-in')).toContainText('Optional.');
  await expect(account.getByTestId('google-sign-in')).toBeVisible();

  await signIn(options, fake, 'student@example.com');
  // Not flagged yet: no cloud storage, and nothing uploaded.
  await expect(account.getByTestId('no-cloud')).toBeVisible();
  expect(fake.chats).toEqual([]);

  // You flag the account; the page reads it again when it opens.
  fake.entitle('student@example.com', { cloud: true });
  await options.reload();
  const toggle = account.getByTestId('cloud-sync');
  await expect(toggle).not.toBeChecked(); // this computer only, until turned on
  await toggle.check();
  await expect(account.getByTestId('sync-status')).toContainText('Up to date', { timeout: 15_000 });
  const uid = fake.userByEmail('student@example.com')!.id;
  expect(fake.row(uid, 'here-1')?.deleted).toBe(false);
  await expect(options.getByTestId('chats')).toContainText('and in your account');

  // A chat from another computer comes down when the panel opens.
  const at = Date.now();
  fake.put(uid, 'laptop-1', at, {
    id: 'laptop-1',
    title: 'From the laptop',
    createdAt: at,
    updatedAt: at,
    items: [{ kind: 'user', id: 'u1', at, text: 'What is a mole?', selections: [] }],
  });
  const panel = await openPanel(context, extensionId);
  await expect
    .poll(async () => serviceWorker.evaluate(async () => ((await chrome.storage.local.get('chatIndex')).chatIndex as { id: string }[]).map((c) => c.id)), {
      timeout: 15_000,
    })
    .toContain('laptop-1');
  await panel.close();

  // Signing out keeps the chats on this computer.
  await account.getByTestId('sign-out').click();
  await expect(account.getByTestId('sign-in')).toBeVisible();
  expect(await serviceWorker.evaluate(async () => !!(await chrome.storage.local.get('chat:here-1'))['chat:here-1'])).toBe(true);
});

test('deleting the account removes it and its cloud copies; chats here stay', async ({ context, extensionId, serviceWorker }) => {
  const fake = new FakeSupabase();
  await serve(context, fake);
  await seedChat(serviceWorker, 'here-1', 'Kinematics');
  fake.entitle('student@example.com', { cloud: true });
  await setSettings(serviceWorker, { cloudSync: true });

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html#account`);
  await signIn(options, fake, 'student@example.com');
  const account = options.getByTestId('section-account');
  await expect(account.getByTestId('sync-status')).toContainText('Up to date', { timeout: 15_000 });
  const uid = fake.userByEmail('student@example.com')!.id;
  expect(fake.row(uid, 'here-1')).toBeDefined();

  await account.getByTestId('delete-account').click();
  await account.getByTestId('confirm-delete-account').click();
  await expect(account.getByTestId('sign-in')).toBeVisible({ timeout: 10_000 });
  expect(fake.users.has(uid)).toBe(false);
  expect(fake.chats).toEqual([]);
  expect(await serviceWorker.evaluate(async () => !!(await chrome.storage.local.get('chat:here-1'))['chat:here-1'])).toBe(true);
});

test('an account with a plan gets hosted answers through the Worker, with its token and no key', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const fake = new FakeSupabase();
  await serve(context, fake);
  fake.entitle('student@example.com', { cloud: false, plan: 'student', monthly_questions: 50 });
  const asked: { auth: string | undefined; body: { model: string; messages: unknown[] } }[] = [];
  await context.route(`${WORKER}/**`, async (route: Route) => {
    const r = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (r.url().endsWith('/me')) {
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'student', quota: 50, used: 3 }) });
    }
    asked.push({ auth: r.headers().authorization, body: r.postDataJSON() });
    const chunks = [
      { choices: [{ delta: { content: 'Hosted: ' } }] },
      { choices: [{ delta: { content: 'Answer: 1/3' } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
    ];
    await route.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'text/event-stream' },
      body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
    });
  });

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  // No hosted choice before signing in.
  await expect(options.getByTestId('answer-hosted')).toHaveCount(0);
  await options.goto(`chrome-extension://${extensionId}/options.html#account`);
  await signIn(options, fake, 'student@example.com');
  await expect(options.getByTestId('hosted-left')).toHaveText('50 of 50 left this month.');
  await options.getByTestId('answer-hosted').click();
  await expect(options.getByTestId('hosted-help')).toContainText('keeps no copy');

  const page = await context.newPage();
  const url = `${FIXTURE_ORIGIN}/katex.html`;
  await page.goto(url);
  const panel = await openPanel(context, extensionId);
  await page.bringToFront();
  await startSelection(serviceWorker, 'box', url);
  await boxAndAsk(page, '#problem');
  await expect(panel.getByTestId('selection')).toBeVisible({ timeout: 15_000 });
  await panel.locator('.macros .macro', { hasText: 'Explain' }).click();
  await expect(panel.locator('.turn.assistant').first()).toContainText('Hosted: Answer: 1/3', { timeout: 15_000 });

  expect(asked).toHaveLength(1);
  expect(asked[0]!.auth).toMatch(/^Bearer at-/); // the account's token, not an API key
  expect(asked[0]!.body.model).toMatch(/^anthropic\/claude-/);
});
