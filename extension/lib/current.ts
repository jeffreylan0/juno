/**
 * Which chat each window's panel shows, and the panel's lifecycle.
 *
 * Every browser window has at most one current chat, kept in storage.session
 * under `current:<windowId>` so it survives the service worker being torn
 * down. The rules:
 *
 *  - Opening the panel starts a new, empty chat. An empty chat is never
 *    written, so opening and closing the panel leaves nothing behind.
 *  - Every selection made in that window goes into the current chat, whichever
 *    page it came from, until the panel closes.
 *  - Closing the panel ends the chat: a saved chat stays in the menu, a
 *    temporary one is deleted.
 *  - A selection made while the panel is closed starts a chat that the panel
 *    takes over when it opens (it usually opens because of that selection).
 *
 * The background calls these one at a time (it serialises every chat write),
 * so none of them has to worry about another running halfway through.
 */
import type { Plan } from '@shared/payload';
import { discardChat, getChat, newChat, saveChat, withSelection, type Chat, type ChatSummary, type SelectionItem } from './chats';
import { storePlanImages } from './images';

export interface Current {
  chatId: string;
  temporary: boolean;
  /**
   * Started by a selection while no panel was open. The next panel to open
   * takes this chat over instead of starting a new one.
   */
  adoptable?: boolean;
}

const PREFIX = 'current:';
export const currentKey = (windowId: number) => `${PREFIX}${windowId}`;

const session = () => (browser.storage as unknown as { session: chrome.storage.StorageArea }).session;

export async function getCurrent(windowId: number): Promise<Current | null> {
  const key = currentKey(windowId);
  return ((await session().get(key))[key] as Current | undefined) ?? null;
}

export async function setCurrent(windowId: number, current: Current | null): Promise<void> {
  if (current) await session().set({ [currentKey(windowId)]: current });
  else await session().remove(currentKey(windowId));
}

export async function allCurrent(): Promise<Array<[number, Current]>> {
  const all = await session().get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PREFIX))
    .map(([k, v]) => [Number(k.slice(PREFIX.length)), v as Current]);
}

const fresh = (temporary = false): Current => ({ chatId: crypto.randomUUID(), temporary });

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

/**
 * A panel connected. `first` is whether it is the only panel open in its
 * window; `claim` is set when a panel that was already open reconnects after
 * the worker restarted, and names the chat it is showing.
 */
export async function panelOpened(
  windowId: number,
  { first, claim }: { first: boolean; claim?: { chatId: string; temporary: boolean } },
): Promise<Current> {
  const current = await getCurrent(windowId);
  let next: Current;
  if (claim) {
    next = current ?? { chatId: claim.chatId, temporary: claim.temporary };
  } else if (current?.adoptable || (!first && current)) {
    next = current;
  } else {
    await leave(current);
    next = fresh();
  }
  next = { chatId: next.chatId, temporary: next.temporary };
  await setCurrent(windowId, next);
  return next;
}

/** The last panel in a window closed: its chat ends. */
export async function panelClosed(windowId: number): Promise<Current | null> {
  const current = await getCurrent(windowId);
  await leave(current);
  await setCurrent(windowId, null);
  return current;
}

/** "New chat", or the ghost to start a temporary one. */
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
    if (current && !(await getChat(current.chatId))) {
      const next = { chatId: current.chatId, temporary: true };
      await setCurrent(windowId, next);
      return next;
    }
    return await startChat(windowId, true);
  }
  if (current && !current.temporary) return current;
  return await startChat(windowId, false);
}

/** A chat picked from the menu. */
export async function switchTo(windowId: number, chatId: string): Promise<Current> {
  const current = await getCurrent(windowId);
  if (current?.chatId !== chatId) await leave(current);
  const next = { chatId, temporary: false };
  await setCurrent(windowId, next);
  return next;
}

/** After chats are deleted or dropped: any window showing one gets a new, empty chat. */
export async function replaceGone(ids: Iterable<string>): Promise<void> {
  const gone = new Set(ids);
  for (const [windowId, current] of await allCurrent()) {
    if (gone.has(current.chatId)) await setCurrent(windowId, fresh(current.temporary));
  }
}

/**
 * A selection arrived from a tab in this window. It joins the current chat,
 * or starts one when there is none (the panel is closed); a chat started that
 * way is taken over by the next panel to open.
 */
export async function addSelection(
  windowId: number,
  { panelOpen, plan, notice, tabId }: { panelOpen: boolean; plan: Plan; notice?: string; tabId?: number },
): Promise<{ chat: Chat; item: SelectionItem; dropped: ChatSummary[] }> {
  let current = await getCurrent(windowId);
  if (!current) {
    current = { ...fresh(), ...(panelOpen ? {} : { adoptable: true }) };
    await setCurrent(windowId, current);
  }
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

/**
 * Clean-up after the worker starts: a window whose panel closed while the
 * worker was not running still has a current chat. Anything not claimed by an
 * open panel (and not waiting for one) is ended.
 */
export async function endUnclaimed(open: (windowId: number) => boolean): Promise<void> {
  for (const [windowId, current] of await allCurrent()) {
    if (open(windowId) || current.adoptable) continue;
    await leave(current);
    await setCurrent(windowId, null);
  }
  // Temporary chats nobody points at any more.
  const live = new Set((await allCurrent()).map(([, c]) => c.chatId));
  const all = await session().get(null);
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith('chat:') && (value as Chat)?.temporary && !live.has(key.slice(5))) {
      onDiscard(key.slice(5));
      await discardChat(key.slice(5));
    }
  }
}
