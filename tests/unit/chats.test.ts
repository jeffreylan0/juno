import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { Plan } from '@shared/payload';
import {
  MAX_SAVED_CHATS,
  autoTitle,
  deleteAllChats,
  deleteChat,
  getChat,
  historyOf,
  isRemovable,
  listChats,
  newChat,
  pendingSelections,
  renameChat,
  retitle,
  saveChat,
  settleStreaming,
  sweepImages,
  updateChat,
  withSelection,
  type AssistantItem,
  type Chat,
  type SelectionItem,
  type UserItem,
} from '@/lib/chats';
import {
  addSelection,
  endUnclaimed,
  getCurrent,
  onTemporaryDiscarded,
  panelClosed,
  panelOpened,
  replaceGone,
  setCurrent,
  setTemporary,
  startChat,
  switchTo,
} from '@/lib/current';
import { MemoryImageStore, deletePartImages, hydratePlan, setImageStore, storePlanImages } from '@/lib/images';
import { groupByDay, search } from '@/ui/ChatMenu';


function plan(id: string, over: Partial<Plan> = {}): Plan {
  return {
    id,
    createdAt: 0,
    mode: 'ask',
    parts: [{ kind: 'text', text: `text ${id}` }],
    selection: { kind: 'text', rect: { x: 0, y: 0, width: 10, height: 10 }, devicePixelRatio: 1 },
    page: { url: `https://example.test/${id}`, title: `Page ${id}` },
    route: 'small',
    estimatedTokens: 5,
    ...over,
  };
}

const shot = (id: string): Plan =>
  plan(id, {
    parts: [{ kind: 'image', dataUrl: `data:image/png;base64,${id}`, width: 4, height: 2, reason: 'user' }],
    selection: { kind: 'box', rect: { x: 0, y: 0, width: 10, height: 10 }, devicePixelRatio: 1 },
  });

const sel = (id: string, p: Plan = plan(id), over: Partial<SelectionItem> = {}): SelectionItem => ({ kind: 'selection', id, at: 1, plan: p, ...over });
const user = (id: string, text: string, selections: string[]): UserItem => ({ kind: 'user', id, at: 1, text, selections });
const answer = (id: string, text: string, over: Partial<AssistantItem> = {}): AssistantItem => ({ kind: 'assistant', id, at: 1, text, ...over });

let store: MemoryImageStore;
beforeEach(() => {
  fakeBrowser.reset();
  store = new MemoryImageStore();
  setImageStore(store);
});

describe('what a question carries', () => {
  it('takes every selection since the last answered question — select, select, ask sends both', () => {
    let chat = newChat();
    chat = withSelection(chat, sel('a'));
    chat = withSelection(chat, sel('b'));
    expect(pendingSelections(chat).map((s) => s.id)).toEqual(['a', 'b']);

    chat = { ...chat, items: [...chat.items, user('q1', 'Compare', ['a', 'b']), answer('r1', 'They differ')] };
    expect(pendingSelections(chat)).toEqual([]);
    chat = withSelection(chat, sel('c'));
    expect(pendingSelections(chat).map((s) => s.id)).toEqual(['c']);
  });

  it('keeps a failed question’s selections pending, so a retry or a new question still sends them', () => {
    const chat: Chat = { ...newChat(), items: [sel('a'), user('q', 'Why?', ['a']), answer('r', '', { error: 'overloaded' })] };
    expect(pendingSelections(chat).map((s) => s.id)).toEqual(['a']);
    expect(historyOf(chat)).toEqual([]);
  });

  it('never carries a selection whose screenshot failed', () => {
    const chat: Chat = { ...newChat(), items: [sel('a', plan('a'), { notice: 'no screenshot' }), sel('b')] };
    expect(pendingSelections(chat).map((s) => s.id)).toEqual(['b']);
  });

  it('builds history from answered pairs, each question with the selections it carried', () => {
    const chat: Chat = {
      ...newChat(),
      items: [sel('a'), user('q1', 'Explain', ['a']), answer('r1', 'A1'), user('q2', 'More', []), answer('r2', 'A2'), user('q3', 'Oops', []), answer('r3', '', { error: 'x' })],
    };
    const h = historyOf(chat);
    expect(h.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(h[0]!.attachments?.map((a) => a.page.title)).toEqual(['Page a']);
    expect(h[2]!.attachments).toBeUndefined();
  });

  it('lets a selection be taken back only until a question carries it', () => {
    const chat: Chat = { ...newChat(), items: [sel('a'), user('q', 'Why?', ['a']), answer('r', 'Because'), sel('b')] };
    expect(isRemovable(chat, 'a')).toBe(false);
    expect(isRemovable(chat, 'b')).toBe(true);
  });
});

describe('titles', () => {
  it('names a chat after its first selection’s page, until the student renames it', () => {
    let chat = withSelection(newChat(), sel('a'));
    chat = withSelection(chat, sel('b'));
    expect(chat.title).toBe('Page a');
    expect(retitle({ ...chat, items: chat.items.slice(1) }).title).toBe('Page b');
    expect(retitle({ ...chat, title: 'Mine', titleEdited: true }).title).toBe('Mine');
  });

  it('falls back to the host, and trims very long titles', () => {
    expect(autoTitle(plan('x', { page: { url: 'https://khanacademy.org/a', title: '  ' } }))).toBe('khanacademy.org');
    expect(autoTitle(plan('x', { page: { url: 'https://a.test', title: 'x'.repeat(200) } })).length).toBe(80);
  });
});

describe('saved chats', () => {
  it('never writes an empty chat', async () => {
    await saveChat(newChat());
    expect(await listChats()).toEqual([]);
  });

  it('keeps the ten most recently used, dropping the oldest with its screenshots', async () => {
    for (let i = 0; i < MAX_SAVED_CHATS; i++) {
      const chat = withSelection(newChat(false, `c${i}`), sel(`s${i}`));
      await saveChat({ ...chat });
      await new Promise((r) => setTimeout(r, 2));
    }
    await store.put({ id: 'img0', chatId: 'c0', dataUrl: 'data:x', createdAt: 0 });
    expect(await listChats()).toHaveLength(MAX_SAVED_CHATS);

    // Using an old chat moves it up, so it is not the one dropped.
    await updateChat('c0', (c) => withSelection(c, sel('again')));
    const { dropped } = await saveChat(withSelection(newChat(false, 'new'), sel('n')));
    expect(dropped.map((c) => c.id)).toEqual(['c1']);
    expect((await listChats()).map((c) => c.id)).toContain('c0');
    expect(await getChat('c1')).toBeNull();

    await deleteChat('c0');
    expect(store.map.size).toBe(0);
  });

  it('does not count or list temporary chats, and keeps them out of local storage', async () => {
    const temp = withSelection(newChat(true, 't'), sel('a'));
    await saveChat(temp);
    expect(await listChats()).toEqual([]);
    expect(await getChat('t')).toMatchObject({ id: 't', temporary: true });
    expect(await fakeBrowser.storage.local.get('chat:t')).toEqual({});
  });

  it('renames without moving the chat, and searches titles, pages and questions', async () => {
    const chat: Chat = { ...withSelection(newChat(false, 'c'), sel('a')), items: [sel('a'), user('q', 'Why is the sky blue?', ['a']), answer('r', 'Rayleigh')] };
    await saveChat(chat);
    const before = (await listChats())[0]!.updatedAt;
    await renameChat('c', '  Optics  homework ');
    const [summary] = await listChats();
    expect(summary!.title).toBe('Optics homework');
    expect(summary!.updatedAt).toBe(before);
    expect(search([summary!], 'optics').length).toBe(1);
    expect(search([summary!], 'page a').length).toBe(1);
    expect(search([summary!], 'SKY blue').length).toBe(1);
    expect(search([summary!], 'sky green')).toEqual([]);
  });

  it('a late write to a deleted chat does not bring it back', async () => {
    await saveChat(withSelection(newChat(false, 'c'), sel('a')));
    await deleteChat('c');
    expect(await updateChat('c', (c) => ({ ...c, title: 'zombie' }))).toBeNull();
    expect(await getChat('c')).toBeNull();
  });

  it('delete all removes every saved chat and screenshot', async () => {
    await saveChat(withSelection(newChat(false, 'a'), sel('x')));
    await saveChat(withSelection(newChat(false, 'b'), sel('y')));
    await store.put({ id: 'i', chatId: 'b', dataUrl: 'data:x', createdAt: 0 });
    await deleteAllChats();
    expect(await listChats()).toEqual([]);
    expect(store.map.size).toBe(0);
  });

  it('settles answers left streaming by a stopped worker', async () => {
    await saveChat({ ...newChat(false, 'c'), items: [sel('a'), user('q', 'Q', ['a']), answer('r', 'half', { streaming: true })] });
    await saveChat({ ...newChat(false, 'd'), items: [sel('b'), user('q', 'Q', ['b']), answer('r', '', { streaming: true })] });
    await settleStreaming();
    expect((await getChat('c'))!.items[2]).toMatchObject({ streaming: false, text: 'half' });
    expect((await getChat('d'))!.items[2]).toMatchObject({ streaming: false, error: 'Stopped before an answer arrived.' });
  });
});

describe('screenshots', () => {
  it('are stored apart from the chat and filled back in for a request', async () => {
    const stored = await storePlanImages(shot('abc'), 'chat1');
    const part = stored.parts[0]!;
    expect(part.kind === 'image' && part.dataUrl.startsWith('idb:')).toBe(true);
    const back = await hydratePlan(stored);
    expect(back.parts[0]).toMatchObject({ dataUrl: 'data:image/png;base64,abc' });
    await deletePartImages(stored.parts);
    expect(store.map.size).toBe(0);
  });

  it('a missing screenshot is dropped rather than sent broken', async () => {
    const stored = await storePlanImages(shot('abc'), 'chat1');
    await store.deleteForChat('chat1');
    expect((await hydratePlan(stored)).parts).toEqual([]);
  });

  it('sweeps images no chat points at', async () => {
    await saveChat(withSelection(newChat(false, 'kept'), sel('a')));
    await store.put({ id: '1', chatId: 'kept', dataUrl: 'd', createdAt: 0 });
    await store.put({ id: '2', chatId: 'gone', dataUrl: 'd', createdAt: 0 });
    await sweepImages();
    expect([...store.map.keys()]).toEqual(['1']);
  });
});

describe('the panel’s lifecycle', () => {
  const W = 7;

  it('opening the panel starts a new chat; closing it ends that chat but keeps it in the menu', async () => {
    const a = await panelOpened(W, { first: true });
    await addSelection(W, { panelOpen: true, plan: plan('x') });
    expect((await getChat(a.chatId))!.items).toHaveLength(1);

    await panelClosed(W);
    expect(await getCurrent(W)).toBeNull();
    expect((await listChats()).map((c) => c.id)).toEqual([a.chatId]);

    const b = await panelOpened(W, { first: true });
    expect(b.chatId).not.toBe(a.chatId);
    expect(await getChat(b.chatId)).toBeNull(); // empty, and not stored
  });

  it('a selection made while the panel is closed is waiting when it opens', async () => {
    const { chat } = await addSelection(W, { panelOpen: false, plan: plan('x') });
    expect((await getCurrent(W))?.adoptable).toBe(true);
    const opened = await panelOpened(W, { first: true });
    expect(opened.chatId).toBe(chat.id);
    expect((await getCurrent(W))?.adoptable).toBeUndefined();
  });

  it('a second panel in the same window joins its chat instead of starting one', async () => {
    const a = await panelOpened(W, { first: true });
    const b = await panelOpened(W, { first: false });
    expect(b.chatId).toBe(a.chatId);
  });

  it('a panel reconnecting after the worker restarted keeps its chat', async () => {
    const a = await panelOpened(W, { first: true });
    await addSelection(W, { panelOpen: true, plan: plan('x') });
    await setCurrent(W, null); // as if nothing were known
    const again = await panelOpened(W, { first: true, claim: { chatId: a.chatId, temporary: false } });
    expect(again.chatId).toBe(a.chatId);
  });

  it('selections from any page join the one chat', async () => {
    await panelOpened(W, { first: true });
    await addSelection(W, { panelOpen: true, plan: plan('a'), tabId: 1 });
    const { chat } = await addSelection(W, { panelOpen: true, plan: plan('b'), tabId: 2 });
    expect(chat.items.map((i) => (i.kind === 'selection' ? i.plan.page.title : ''))).toEqual(['Page a', 'Page b']);
    expect(chat.title).toBe('Page a');
  });

  it('each window has its own chat', async () => {
    await panelOpened(1, { first: true });
    await panelOpened(2, { first: true });
    await addSelection(1, { panelOpen: true, plan: plan('a') });
    await addSelection(2, { panelOpen: true, plan: plan('b') });
    expect((await getCurrent(1))!.chatId).not.toBe((await getCurrent(2))!.chatId);
  });

  it('a temporary chat keeps its screenshots in memory, and is deleted with them when the panel closes', async () => {
    const memImages = async () => Object.keys(await fakeBrowser.storage.session.get(null)).filter((k) => k.startsWith('img:'));
    await panelOpened(W, { first: true });
    const temp = await setTemporary(W, true);
    const { item } = await addSelection(W, { panelOpen: true, plan: shot('s') });
    // Never on disk: not in IndexedDB, not in the menu.
    expect(store.map.size).toBe(0);
    expect(await memImages()).toHaveLength(1);
    expect((await hydratePlan(item.plan)).parts[0]).toMatchObject({ dataUrl: 'data:image/png;base64,s' });
    expect(await listChats()).toEqual([]);

    await panelClosed(W);
    expect(await getChat(temp.chatId)).toBeNull();
    expect(await memImages()).toEqual([]);
  });

  it('tells the background which temporary chat is going, so its answer can stop', async () => {
    const gone: string[] = [];
    onTemporaryDiscarded((id) => gone.push(id));
    await panelOpened(W, { first: true });
    const temp = await setTemporary(W, true);
    await addSelection(W, { panelOpen: true, plan: plan('a') });
    await startChat(W, false);
    expect(gone).toEqual([temp.chatId]);
    onTemporaryDiscarded(() => {});
  });

  it('the ghost turns an empty chat temporary, but starts a separate one when the chat has content', async () => {
    const empty = await panelOpened(W, { first: true });
    const t1 = await setTemporary(W, true);
    expect(t1).toEqual({ chatId: empty.chatId, temporary: true });
    const off = await setTemporary(W, false);
    expect(off.temporary).toBe(false);

    await addSelection(W, { panelOpen: true, plan: plan('a') });
    const saved = (await getCurrent(W))!;
    const t2 = await setTemporary(W, true);
    expect(t2.chatId).not.toBe(saved.chatId);
    expect(await getChat(saved.chatId)).not.toBeNull();
  });

  it('leaving a temporary chat any way deletes it: new chat, opening another, the ghost', async () => {
    for (const leave of [() => startChat(W, false), () => switchTo(W, 'other'), () => setTemporary(W, false)]) {
      await startChat(W, true);
      const { chat } = await addSelection(W, { panelOpen: true, plan: plan('a') });
      await leave();
      expect(await getChat(chat.id)).toBeNull();
    }
  });

  it('a window showing a deleted chat moves to a new, empty one', async () => {
    await panelOpened(W, { first: true });
    const { chat } = await addSelection(W, { panelOpen: true, plan: plan('a') });
    await deleteChat(chat.id);
    await replaceGone([chat.id]);
    const now = (await getCurrent(W))!;
    expect(now.chatId).not.toBe(chat.id);
  });

  it('after a restart, a chat whose panel is gone is ended, unless a selection is waiting for it', async () => {
    await panelOpened(1, { first: true });
    await setTemporary(1, true);
    const { chat: temp } = await addSelection(1, { panelOpen: true, plan: plan('a') });
    await addSelection(2, { panelOpen: false, plan: plan('b') });
    await endUnclaimed(() => false);
    expect(await getCurrent(1)).toBeNull();
    expect(await getChat(temp.id)).toBeNull();
    expect((await getCurrent(2))?.adoptable).toBe(true);
  });
});

describe('menu groups', () => {
  it('groups by last use: Today, Yesterday, Previous 7 days, Older', () => {
    const now = new Date(2026, 8, 29, 15).getTime();
    const at = (daysAgo: number) => ({ id: `${daysAgo}`, title: '', createdAt: 0, updatedAt: now - daysAgo * 86_400_000, search: '' });
    const groups = groupByDay([at(0), at(1), at(3), at(30)], now);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Older']);
  });
});
