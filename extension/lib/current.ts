/**
 * Which chat each window is on, and when a chat begins and ends.
 *
 * The selection bar and the panel are one thing that the student shows and
 * hides. The rules:
 *
 *  - Clicking the shortcut icon (or pressing the shortcut) brings up the bar.
 *    It is one bar per window, not per tab: it follows the student to
 *    whichever tab is active, in whatever state it was in (selecting in a
 *    mode, or waiting between selections).
 *  - The first selection starts a chat; every later one joins it, whichever
 *    tab it comes from.
 *  - ✕ on the bar, ✕ on the side panel, or Escape while the bar is waiting
 *    hides both and finishes the chat: a saved chat stays in the menu, a
 *    temporary one is deleted. The next click on the icon starts a new chat.
 *
 * State lives in storage.session so it survives the service worker being torn
 * down: `current:<windowId>` names the chat, `bar:<windowId>` says the bar is
 * up, what it is doing and which tab it is on. The background calls these one
 * at a time (it serialises every chat write), so none of them has to worry
 * about another running halfway.
 */
import type { Plan, SelectionKind } from '@shared/payload';
import { discardChat, getChat, newChat, saveChat, withSelection, type Chat, type ChatSummary, type SelectionItem } from './chats';
import { storePlanImages } from './images';

export interface Current {
  chatId: string;
  temporary: boolean;
}

const PREFIX = 'current:';
export const currentKey = (windowId: number) => `${PREFIX}${windowId}`;

/** Why the bar is not on the active tab, when it cannot be. */
export type BarBlocked = 'permission' | 'restricted' | 'blocked-site';

/** The one bar of a window. */
export interface BarState {
  /** The mode being selected in, or null while it waits between selections. */
  mode: SelectionKind | null;
  /** The tab it is on now, if it could be put on the active tab. */
  tabId?: number;
  blocked?: BarBlocked;
}

const BAR_PREFIX = 'bar:';
export const barKey = (windowId: number) => `${BAR_PREFIX}${windowId}`;

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

// ── The bar ──────────────────────────────────────────────────────────────

export async function getBar(windowId: number): Promise<BarState | null> {
  const key = barKey(windowId);
  return ((await session().get(key))[key] as BarState | undefined) ?? null;
}

/** Updates the window's bar, bringing it up if it was not. Returns the new state. */
export async function setBar(windowId: number, patch: Partial<BarState>): Promise<BarState> {
  const next: BarState = { mode: null, ...(await getBar(windowId)), ...patch };
  for (const k of Object.keys(next) as (keyof BarState)[]) if (next[k] === undefined) delete next[k];
  await session().set({ [barKey(windowId)]: next });
  return next;
}

export async function allBars(): Promise<Array<[number, BarState]>> {
  const all = await session().get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(BAR_PREFIX))
    .map(([k, v]) => [Number(k.slice(BAR_PREFIX.length)), v as BarState]);
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
 * Hides the bar and the panel's chat: ✕ on either, or Escape on a waiting
 * bar. Returns the tab the bar was on, to take it down.
 */
export async function endChat(windowId: number): Promise<number | undefined> {
  const bar = await getBar(windowId);
  await leave(await getCurrent(windowId));
  await setCurrent(windowId, null);
  await session().remove(barKey(windowId));
  return bar?.tabId;
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
