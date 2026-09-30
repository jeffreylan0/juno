/**
 * The settings page: four sections in the order a student meets them, only
 * what applies on screen, and every change saved as it is made.
 */
import { expect, test } from './fixtures';

const stored = async (sw: import('@playwright/test').Worker) =>
  (await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings)) as Record<string, unknown> | undefined;

test('four sections, in order, and every change saves as it is made', async ({ context, extensionId, serviceWorker }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);

  await expect(options.locator('section h2')).toHaveText(['Answers', 'Asking', 'Selecting', 'Chats & privacy']);
  await expect(options.locator('.tabs a')).toHaveText(['Answers', 'Asking', 'Selecting', 'Chats & privacy']);

  // A macro renamed and rewritten; a blank one added but not saved.
  const rows = options.getByTestId('macro-row');
  await expect(rows).toHaveCount(3);
  await rows.nth(0).locator('.macro-name').fill('Walk me through it');
  await options.getByTestId('add-macro').click();
  await expect(rows).toHaveCount(4);
  await expect
    .poll(async () => ((await stored(serviceWorker))?.macros as { name: string }[] | undefined)?.map((m) => m.name))
    .toEqual(['Walk me through it', 'Hint', 'Check']);

  await options.getByTestId('default-prompt').fill('Solve it.');
  await options.getByTestId('blocked-sites').fill('Exam.Example.edu\nportal.school.org');
  await options.getByLabel('Let me adjust it first').check();
  await options.getByLabel('Ask straight away for screenshots only').check();
  await expect
    .poll(async () => {
      const s = await stored(serviceWorker);
      return { prompt: s?.defaultPrompt, blocked: s?.blockedSites, adjust: s?.adjustBox, send: s?.sendBehavior };
    })
    .toEqual({ prompt: 'Solve it.', blocked: ['exam.example.edu', 'portal.school.org'], adjust: true, send: 'auto-box' });

  // Reloading shows what was saved; the blank macro draft is gone.
  await options.reload();
  await expect(options.getByTestId('macro-row')).toHaveCount(3);
  await expect(options.getByTestId('default-prompt')).toHaveValue('Solve it.');
  await expect(options.getByLabel('Let me adjust it first')).toBeChecked();
});

test('a key can be removed, and an edit made just before switching is kept', async ({ context, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(async () => chrome.storage.local.set({ keys: { anthropic: 'sk-ant-old', openai: '', session: '' } }));
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);

  // Emptying the key field and leaving it removes the key.
  await options.getByTestId('answer-claude').click();
  const input = options.getByTestId('key-input');
  await expect(input).toHaveValue('sk-ant-old');
  await input.fill('');
  await input.blur();
  await expect
    .poll(async () => serviceWorker.evaluate(async () => (await chrome.storage.local.get('keys')).keys?.anthropic))
    .toBe('');

  // A server address typed and then left at once for another choice is still saved.
  await options.getByTestId('answer-local').click();
  await options.getByTestId('local').locator('input').first().fill('http://127.0.0.1:1234/v1');
  await options.getByTestId('answer-placeholder').click();
  await expect
    .poll(async () => ((await serviceWorker.evaluate(async () => (await chrome.storage.local.get('settings')).settings)) as { localBaseUrl?: string; provider?: string }))
    .toMatchObject({ localBaseUrl: 'http://127.0.0.1:1234/v1', provider: 'mock' });
});
