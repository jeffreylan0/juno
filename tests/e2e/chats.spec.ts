/**
 * Chat management: the menu (search, rename, delete), temporary chats, the
 * free plan's ten-chat limit, and the notices above the macros. Mock answers
 * throughout, so nothing here costs anything.
 */
import type { Page, Route, Worker } from '@playwright/test';
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
  test,
} from './fixtures';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

/** Opens a fixture, boxes its problem (or table), and waits for it to land in the panel. */
async function selectOn(page: Page, sw: Worker, panel: Page, path: string, selector = '#problem'): Promise<void> {
  const url = `${FIXTURE_ORIGIN}/${path}`;
  if (page.url() !== url) await page.goto(url);
  const before = await panel.getByTestId('selection').count();
  await page.bringToFront();
  await startSelection(sw, 'box', url);
  await boxAndAsk(page, selector);
  await expect(panel.getByTestId('selection')).toHaveCount(before + 1, { timeout: 15_000 });
}

async function askAndWait(panel: Page, macro = 'Explain'): Promise<void> {
  const before = await panel.locator('.turn.assistant').count();
  await panel.locator('.macros .macro', { hasText: macro }).click();
  await expect(panel.locator('.turn.assistant').nth(before)).toHaveAttribute('data-streaming', 'false', { timeout: 25_000 });
}

test('the menu lists saved chats; search, rename and delete work in place', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const panel = await openPanel(context, extensionId);

  await selectOn(page, serviceWorker, panel, 'text.html');
  await askAndWait(panel);
  const firstTitle = await page.title();

  // New chat: the first stays in the menu, the panel empties.
  await panel.getByTestId('menu').click();
  await panel.getByTestId('new-chat').click();
  await expect(panel.getByTestId('empty')).toBeVisible();
  await selectOn(page, serviceWorker, panel, 'table.html', 'table');
  await askAndWait(panel);
  const secondTitle = await page.title();
  expect(secondTitle).not.toBe(firstTitle);

  await panel.getByTestId('menu').click();
  const menu = panel.getByTestId('chat-menu');
  const rows = menu.getByTestId('chat-row');
  // Newest first, the current one marked.
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(secondTitle);
  await expect(rows.nth(0)).toHaveAttribute('data-active', 'true');
  await expect(menu.locator('h3').first()).toHaveText('Today');
  await expect(menu.getByTestId('chat-limit')).toContainText('10 most recent chats');

  // Search looks at titles, pages and questions.
  await menu.getByTestId('chat-search').fill('Plain TEXT');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(firstTitle);
  await menu.getByTestId('chat-search').fill('no such chat anywhere');
  await expect(rows).toHaveCount(0);
  await expect(menu.getByTestId('chat-list-empty')).toContainText('No chats match');
  await menu.getByTestId('chat-search').fill('');

  // Rename in the menu.
  await rows.nth(1).hover();
  await rows.nth(1).getByTestId('rename-chat').click();
  await menu.getByTestId('title-input').fill('Stoichiometry homework');
  await menu.getByTestId('title-input').press('Enter');
  await expect(rows.nth(1)).toContainText('Stoichiometry homework');

  // Open it, and rename it again from the top bar.
  await rows.nth(1).locator('.chat-open').click();
  await expect(panel.getByTestId('chat-title')).toHaveText('Stoichiometry homework');
  await panel.getByTestId('chat-title').click();
  await panel.getByTestId('title-input').fill('Balancing equations');
  await panel.getByTestId('title-input').press('Enter');
  await expect(panel.getByTestId('chat-title')).toHaveText('Balancing equations');
  // A renamed chat keeps its name when more is selected into it.
  await selectOn(page, serviceWorker, panel, 'text.html');
  await expect(panel.getByTestId('chat-title')).toHaveText('Balancing equations');

  // Delete asks first; deleting the chat on screen leaves an empty one.
  await panel.getByTestId('menu').click();
  const renamed = rows.filter({ hasText: 'Balancing equations' });
  await renamed.hover();
  await renamed.getByTestId('delete-chat').click();
  await expect(rows.filter({ hasText: 'Delete “Balancing equations”?' })).toHaveCount(1);
  await menu.getByTestId('confirm-delete').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(secondTitle);
  await panel.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(panel.getByTestId('empty')).toBeVisible();
  expect((await savedChats(serviceWorker)).map((c) => c.title)).toEqual([secondTitle]);
});

test('a temporary chat is never listed and is deleted when the panel closes', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const panel = await openPanel(context, extensionId);

  const ghost = panel.getByTestId('temporary');
  await ghost.click();
  await expect(ghost).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('chat-title')).toHaveText('Temporary chat');
  await expect(panel.getByTestId('empty')).toContainText("deleted when you close the panel");

  await selectOn(page, serviceWorker, panel, 'text.html');
  await askAndWait(panel);
  const chat = (await currentChat(panel))!;
  expect(chat.temporary).toBe(true);
  // Its screenshot is kept in memory, never written to disk.
  await expect(panel.locator('.selection-image')).toBeVisible();
  expect(JSON.stringify(chat.items[0])).toContain('mem:');
  // Kept in memory only, and never in the menu.
  expect(await savedChats(serviceWorker)).toEqual([]);
  await panel.getByTestId('menu').click();
  await expect(panel.getByTestId('chat-row')).toHaveCount(0);
  await panel.getByTestId('menu-close').click();

  // Closing the panel deletes it, screenshots included.
  await closeSidePanels(serviceWorker);
  await panel.close();
  await expect
    .poll(async () =>
      serviceWorker.evaluate(async (id) => {
        const session = await chrome.storage.session.get(null);
        const inSession = `chat:${id}` in session || Object.keys(session).some((k) => k.startsWith('img:'));
        const images = await new Promise<number>((resolve) => {
          const open = indexedDB.open('selection-ai');
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains('images')) return resolve(0);
            const req = db.transaction('images').objectStore('images').index('chatId').count(id);
            req.onsuccess = () => resolve(req.result);
          };
        });
        return { inSession, images };
      }, chat.id),
    )
    .toEqual({ inSession: false, images: 0 });

  // The next panel is a normal, empty chat.
  const next = await openPanel(context, extensionId);
  await expect(next.getByTestId('temporary')).toHaveAttribute('aria-pressed', 'false');
  await expect(next.getByTestId('chat-title')).toHaveText('New chat');
});

test('leaving a temporary chat with the ghost deletes it; the chat before stays saved', async ({ context, extensionId, serviceWorker }) => {
  const page = await context.newPage();
  const panel = await openPanel(context, extensionId);
  await selectOn(page, serviceWorker, panel, 'text.html');
  await askAndWait(panel);
  const saved = (await currentChat(panel))!;

  // With something in the chat, the ghost starts a separate temporary one.
  await panel.getByTestId('temporary').click();
  await expect(panel.getByTestId('chat-title')).toHaveText('Temporary chat');
  await expect(panel.getByTestId('selection')).toHaveCount(0);
  await selectOn(page, serviceWorker, panel, 'table.html', 'table');
  const temp = (await currentChat(panel))!;
  expect(temp.id).not.toBe(saved.id);

  await panel.getByTestId('temporary').click();
  await expect(panel.getByTestId('chat-title')).toHaveText('New chat');
  await expect.poll(async () => serviceWorker.evaluate(async (id) => `chat:${id}` in (await chrome.storage.session.get(null)), temp.id)).toBe(false);
  expect((await savedChats(serviceWorker)).map((c) => c.id)).toEqual([saved.id]);
});

test('the free plan keeps ten chats: the oldest goes, and the panel says so', async ({ context, extensionId, serviceWorker }) => {
  // Ten older chats, as earlier sessions would have left them.
  await serviceWorker.evaluate(async () => {
    const index = [];
    const items: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      const id = `old-${i}`;
      const at = Date.now() - (10 - i) * 3_600_000;
      const plan = {
        id: `p${i}`,
        mode: 'ask',
        route: 'small',
        page: { url: `https://example.com/${i}`, title: `Old chat ${i}` },
        selection: { kind: 'text', rect: { x: 0, y: 0, width: 1, height: 1 }, devicePixelRatio: 1 },
        parts: [{ kind: 'text', text: `problem ${i}` }],
        question: '',
      };
      items[`chat:${id}`] = { id, title: `Old chat ${i}`, createdAt: at, updatedAt: at, items: [{ kind: 'selection', id: `s${i}`, at, plan }] };
      index.push({ id, title: `Old chat ${i}`, createdAt: at, updatedAt: at, search: `old chat ${i}` });
    }
    await chrome.storage.local.set({ ...items, chatIndex: index });
  });

  const page = await context.newPage();
  const panel = await openPanel(context, extensionId);
  await selectOn(page, serviceWorker, panel, 'text.html');

  const list = await savedChats(serviceWorker);
  expect(list).toHaveLength(10);
  expect(list.map((c) => c.id)).not.toContain('old-0');
  expect(await serviceWorker.evaluate(async () => 'chat:old-0' in (await chrome.storage.local.get(null)))).toBe(false);
  const notice = panel.locator('[data-testid="notice"][data-kind="dropped"]');
  await expect(notice).toContainText('The free plan keeps 10 chats, so the oldest, “Old chat 0”, was deleted.');
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
});

test('notices sit above the macros: no key, and a disconnected AI with a retry', async ({ context, extensionId, serviceWorker }) => {
  let reachable = false;
  await context.route('https://api.anthropic.com/v1/models**', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (!reachable) return route.abort('internetdisconnected');
    await route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ data: [] }) });
  });

  await setSettings(serviceWorker, { provider: 'byok', vendor: 'anthropic' });
  const panel = await openPanel(context, extensionId);

  // Claude picked, but no key yet.
  const noKey = panel.locator('[data-testid="notice"][data-kind="no-key"]');
  await expect(noKey).toContainText('No Claude API key yet');
  // Yellow, and above the macros.
  const bg = await noKey.evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g)!.map(Number);
  expect(r).toBeGreaterThan(240);
  expect(g).toBeGreaterThan(230);
  expect(b!).toBeLessThan(r! - 20);
  const noticeBox = (await noKey.boundingBox())!;
  const macrosBox = (await panel.locator('.macros').boundingBox())!;
  expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(macrosBox.y);

  // A key, but Anthropic cannot be reached.
  await serviceWorker.evaluate(async () => chrome.storage.local.set({ keys: { anthropic: 'sk-ant-test', openai: '', session: '' } }));
  const down = panel.locator('[data-testid="notice"][data-kind="disconnected"]');
  await expect(down).toContainText('Disconnected.', { timeout: 15_000 });
  await expect(down).toContainText("Can't reach Anthropic");

  // Back online: Retry checks again, and the notice goes.
  reachable = true;
  await down.getByTestId('notice-retry').click();
  await expect(panel.getByTestId('notice')).toHaveCount(0, { timeout: 15_000 });
});
