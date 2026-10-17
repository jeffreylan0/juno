/**
 * Which chat each window is on, and when a chat begins and ends.
 *
 * The rules:
 *
 *  - Clicking the shortcut icon (or pressing the shortcut) brings up the
 *    selection bar on that tab. Leaving the tab takes the bar away; the icon
 *    brings it back wherever the student is. Nothing about it is remembered.
 *  - The panel opens with the first selection, and that selection starts a
 *    chat; every later one joins it, whichever tab it comes from. The panel
 *    stays open from tab to tab.
 *  - The ghost (on the bar or the panel) makes the next selection start a
 *    temporary chat, which is never saved.
 *  - ✕ on the bar, ✕ on the side panel, or Escape while the bar is waiting
 *    hides both and finishes the chat: a saved chat stays in the menu, a
 *    temporary one is deleted. The next click on the icon starts a new chat.
 *
 * State lives in storage.session so it survives the service worker being torn
 * down: `current:<windowId>` names the chat, and `bar:<windowId>` the one tab
 * the bar is on, so switching away can take it off. The background calls these
 * one at a time (it serialises every chat write), so none of them has to worry
 * about another running halfway.
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

const barKey = (windowId: number) => `bar:${windowId}`;

/** The tab the window's bar is on, if it is up. */
export async function getBarTab(windowId: number): Promise<number | undefined> {
  return (await session().get(barKey(windowId)))[barKey(windowId)] as number | undefined;
}

export async function setBarTab(windowId: number, tabId: number | null): Promise<void> {
  if (tabId === null) await session().remove(barKey(windowId));
  else await session().set({ [barKey(windowId)]: tabId });
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

/** Finishes the window's chat: ✕ on the bar or the panel, or Escape on a waiting bar. */
export async function endChat(windowId: number): Promise<void> {
  await leave(await getCurrent(windowId));
  await setCurrent(windowId, null);
  await setBarTab(windowId, null);
}

/** Leaves the chat in progress for a new, empty one. */
export async function startChat(windowId: number, temporary: boolean): Promise<Current> {
  await leave(await getCurrent(windowId));
  const next = fresh(temporary);
  await setCurrent(windowId, next);
  return next;
}

/**
 * The ghost. Turning it on with nothing in the chat yet (or no chat at all:
 * the bar is up, the panel not yet open) makes the chat the next selection
 * starts temporary; with something in it, it starts a temporary chat and the
 * other one stays in the menu. Turning it off deletes the temporary chat.
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

/**
 * A selection arrived from a tab in this window: it joins the chat in
 * progress, or starts one. `into` is the chat it was made for, fixed when it
 * was committed: if the student moved on while it was being captured (✕, the
 * ghost, another chat from the menu), it still goes there — unless that chat
 * is gone (finished before anything was in it, or temporary and deleted),
 * which is not brought back. Then it is dropped and null returned.
 */
export async function addSelection(
  windowId: number,
  { plan, notice, tabId, into }: { plan: Plan; notice?: string; tabId?: number; into?: Current },
): Promise<{ chat: Chat; item: SelectionItem; dropped: ChatSummary[] } | null> {
  const now = into ? await getCurrent(windowId) : await ensureCurrent(windowId);
  const target = into ?? now!;
  const existing = await getChat(target.chatId);
  const stillHere = now?.chatId === target.chatId;
  if (!stillHere && !existing) return null;
  const base = existing ?? newChat(stillHere ? now!.temporary : target.temporary, target.chatId);
  const item: SelectionItem = {
    kind: 'selection',
    id: crypto.randomUUID(),
    at: Date.now(),
    plan: await storePlanImages(plan, base.id, !!base.temporary),
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
