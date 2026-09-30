/**
 * Which chat each window is on, and when a chat begins and ends.
 *
 * The selection bar leads; the panel follows it. A chat is "in progress" in a
 * window while the student is selecting there, and the rules are:
 *
 *  - Clicking the shortcut icon (or pressing the shortcut) summons the bar on
 *    the current tab. With no chat in progress in the window, the first
 *    selection starts a new one; with a chat in progress, the bar joins it —
 *    on any tab, so one chat can gather selections across pages.
 *  - After each selection the bar stays on its page, ready for the next.
 *  - The bar's ✕ finishes the chat: every bar in the window goes, the panel
 *    closes, and the chat stays in the menu (a temporary one is deleted).
 *  - Closing only the panel leaves the chat in progress while a bar is still
 *    up; the next selection brings the panel back on the same chat. Once no
 *    bar and no panel are left (tabs closed, pages navigated away), the chat
 *    ends as if ✕ had been pressed.
 *
 * State lives in storage.session so it survives the service worker being torn
 * down: `current:<windowId>` names the chat, `bars` maps each tab showing a bar
 * to its window. The background calls these one at a time (it serialises every
 * chat write), so none of them has to worry about another running halfway.
 */
import type { Plan } from '@shared/payload';
import { discardChat, getChat, newChat, saveChat, withSelection, type Chat, type ChatSummary, type SelectionItem } from './chats';
import { storePlanImages } from './images';

export interface Current {
  chatId: string;
  temporary: boolean;
}

const PREFIX = 'current:';
export const currentKey = (windowId: number) => `${PREFIX}${windowId}`;
export const BARS_KEY = 'bars';

const session = () => (browser.storage as unknown as { session: chrome.storage.StorageArea }).session;

export async function getCurrent(windowId: number): Promise<Current | null> {
  const key = currentKey(windowId);
  return ((await session().get(key))[key] as Current | undefined) ?? null;
}

export async function setCurrent(windowId: number, current: Current | null): Promise<void> {
  if (current) await session().set({ [currentKey(windowId)]: { chatId: current.chatId, temporary: current.temporary } });
  else await session().remove(currentKey(windowId));
}

export async function allCurrent(): Promise<Array<[number, Current]>> {
  const all = await session().get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PREFIX))
    .map(([k, v]) => [Number(k.slice(PREFIX.length)), v as Current]);
}

const fresh = (temporary = false): Current => ({ chatId: crypto.randomUUID(), temporary });

/** The window's chat in progress, starting one if there is none. */
export async function ensureCurrent(windowId: number): Promise<Current> {
  const current = await getCurrent(windowId);
  if (current) return current;
  const next = fresh();
  await setCurrent(windowId, next);
  return next;
}

let onDiscard: (chatId: string) => void = () => {};
/** Called just before a temporary chat is deleted, so its answer can stop streaming (and billing). */
export function onTemporaryDiscarded(fn: (chatId: string) => void): void {
  onDiscard = fn;
}

/** Leaves the window's current chat. A temporary chat does not outlive being left. */
async function leave(current: Current | null): Promise<void> {
  if (!current?.temporary) return;
  onDiscard(current.chatId);
  await discardChat(current.chatId);
}

// ── Bars ─────────────────────────────────────────────────────────────────

type Bars = Record<string, number>;

async function getBars(): Promise<Bars> {
  return ((await session().get(BARS_KEY))[BARS_KEY] as Bars | undefined) ?? {};
}

/** A bar appeared on a tab. */
export async function barShown(tabId: number, windowId: number): Promise<void> {
  const bars = await getBars();
  if (bars[tabId] === windowId) return;
  await session().set({ [BARS_KEY]: { ...bars, [tabId]: windowId } });
}

/** A bar went away on its own (Escape before it added anything, the page left). Returns its window. */
export async function barGone(tabId: number): Promise<number | undefined> {
  const bars = await getBars();
  const windowId = bars[tabId];
  if (windowId === undefined) return undefined;
  delete bars[tabId];
  await session().set({ [BARS_KEY]: bars });
  return windowId;
}

/** Tabs showing a bar in this window. */
export async function barsIn(windowId: number): Promise<number[]> {
  return Object.entries(await getBars())
    .filter(([, w]) => w === windowId)
    .map(([t]) => Number(t));
}

// ── The chat's life ──────────────────────────────────────────────────────

/**
 * A panel connected. It shows the chat in progress, or starts one (a panel
 * opened by hand, before any selection). `claim` is set when a panel that was
 * already open reconnects after the worker restarted, and names its chat.
 */
export async function panelOpened(windowId: number, claim?: Current): Promise<Current> {
  const current = (await getCurrent(windowId)) ?? claim ?? fresh();
  await setCurrent(windowId, current);
  return current;
}

/**
 * Finishes the window's chat: the bar's ✕, or nothing left open. Returns the
 * tabs whose bars should be taken down.
 */
export async function endChat(windowId: number): Promise<number[]> {
  await leave(await getCurrent(windowId));
  await setCurrent(windowId, null);
  const tabs = await barsIn(windowId);
  const bars = await getBars();
  for (const t of tabs) delete bars[t];
  await session().set({ [BARS_KEY]: bars });
  return tabs;
}

/** The ghost, turned on with something already in the chat: a separate, temporary chat. */
export async function startChat(windowId: number, temporary: boolean): Promise<Current> {
  await leave(await getCurrent(windowId));
  const next = fresh(temporary);
  await setCurrent(windowId, next);
  return next;
}

/**
 * The ghost. Turning it on with nothing in the chat yet makes this chat
 * temporary; with something in it, it starts a temporary chat and the other
 * one stays in the menu. Turning it off deletes the temporary chat.
 */
export async function setTemporary(windowId: number, on: boolean): Promise<Current> {
  const current = await getCurrent(windowId);
  if (on) {
    if (current?.temporary) return current;
    if (!current || !(await getChat(current.chatId))) {
      const next = { chatId: current?.chatId ?? crypto.randomUUID(), temporary: true };
      await setCurrent(windowId, next);
      return next;
    }
    return await startChat(windowId, true);
  }
  if (current && !current.temporary) return current;
  return await startChat(windowId, false);
}

/** A chat picked from the menu: selecting carries on in it. */
export async function switchTo(windowId: number, chatId: string): Promise<Current> {
  const current = await getCurrent(windowId);
  if (current?.chatId !== chatId) await leave(current);
  const next = { chatId, temporary: false };
  await setCurrent(windowId, next);
  return next;
}

/** After chats are deleted or dropped: any window on one carries on in a new, empty chat. */
export async function replaceGone(ids: Iterable<string>): Promise<void> {
  const gone = new Set(ids);
  for (const [windowId, current] of await allCurrent()) {
    if (gone.has(current.chatId)) await setCurrent(windowId, fresh(current.temporary));
  }
}

/** A selection arrived from a tab in this window: it joins the chat in progress, or starts one. */
export async function addSelection(
  windowId: number,
  { plan, notice, tabId }: { plan: Plan; notice?: string; tabId?: number },
): Promise<{ chat: Chat; item: SelectionItem; dropped: ChatSummary[] }> {
  const current = await ensureCurrent(windowId);
  const base = (await getChat(current.chatId)) ?? newChat(current.temporary, current.chatId);
  const item: SelectionItem = {
    kind: 'selection',
    id: crypto.randomUUID(),
    at: Date.now(),
    plan: await storePlanImages(plan, current.chatId, current.temporary),
    ...(notice ? { notice } : {}),
    ...(tabId !== undefined ? { tabId } : {}),
  };
  const { chat, dropped } = await saveChat(withSelection(base, item));
  if (dropped.length) await replaceGone(dropped.map((c) => c.id));
  return { chat, item, dropped };
}

/** Temporary chats no window is on any more (a crash, a worker stopped mid-cleanup). */
export async function discardOrphans(): Promise<void> {
  const live = new Set((await allCurrent()).map(([, c]) => c.chatId));
  const all = await session().get(null);
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('chat:') && (value as Chat)?.temporary && !live.has(key.slice(5))) {
      onDiscard(key.slice(5));
      await discardChat(key.slice(5));
    }
  }
}
