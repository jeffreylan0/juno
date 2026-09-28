/**
 * One conversation per tab.
 *
 * Each tab keeps its own selection and its own back-and-forth with the model,
 * so switching from a textbook to a paper switches the panel with it. The
 * background is the only writer: it appends the student's turn, streams the
 * answer into the thread, and the panel just renders whatever is stored for
 * the tab it is looking at.
 *
 * Stored in `storage.session`, not in background memory. An MV3 service
 * worker is torn down after ~30s idle, which would silently drop every
 * conversation; session storage survives that, lives only in memory, clears
 * when the browser closes, and is not readable from content scripts — so the
 * page can never see a student's thread.
 *
 * The selection and the conversation are separate keys on purpose. The
 * selection can carry a megabyte of base64 image and is written once; the
 * conversation is rewritten many times a second while an answer streams, and
 * should not drag the image along each time.
 */
import type { ChatTurn, Mode, ModelRef, Plan, Usage } from '@shared/payload';

export interface Turn extends ChatTurn {
  id: string;
  streaming?: boolean;
  usage?: Usage;
  model?: ModelRef;
  cached?: boolean;
  error?: string;
}

export interface Chat {
  /** The plan this conversation belongs to; a new selection starts a new chat. */
  planId: string;
  mode: Mode;
  turns: Turn[];
  updatedAt: number;
}

export interface Thread {
  tabId: number;
  plan: Plan | null;
  chat: Chat | null;
}

export const selKey = (tabId: number) => `sel:${tabId}`;
export const chatKey = (tabId: number) => `chat:${tabId}`;

/** Parses a storage key back to its tab and kind; null for anything else. */
export function parseKey(key: string): { tabId: number; kind: 'sel' | 'chat' } | null {
  const m = /^(sel|chat):(\d+)$/.exec(key);
  return m ? { kind: m[1] as 'sel' | 'chat', tabId: Number(m[2]) } : null;
}

function area(): chrome.storage.StorageArea {
  return (browser.storage as unknown as { session: chrome.storage.StorageArea }).session;
}

export async function getThread(tabId: number): Promise<Thread> {
  const got = await area().get([selKey(tabId), chatKey(tabId)]);
  return {
    tabId,
    plan: (got[selKey(tabId)] as Plan | undefined) ?? null,
    chat: (got[chatKey(tabId)] as Chat | undefined) ?? null,
  };
}

/** A new selection in this tab: store it and start a fresh, empty conversation. */
export async function startThread(tabId: number, plan: Plan): Promise<Thread> {
  const chat: Chat = { planId: plan.id, mode: plan.mode, turns: [], updatedAt: Date.now() };
  await setWithEviction({ [selKey(tabId)]: plan, [chatKey(tabId)]: chat });
  return { tabId, plan, chat };
}

export async function saveChat(tabId: number, chat: Chat): Promise<void> {
  await setWithEviction({ [chatKey(tabId)]: { ...chat, updatedAt: Date.now() } });
}

export async function setThreadMode(tabId: number, mode: Mode): Promise<void> {
  const { chat } = await getThread(tabId);
  if (chat) await saveChat(tabId, { ...chat, mode });
}

export async function clearThread(tabId: number): Promise<void> {
  await area().remove([selKey(tabId), chatKey(tabId)]);
}

/**
 * Session storage is capped (10 MB in Chrome). Screenshots are the bulk of
 * it, so on a quota error the least recently touched tab's thread goes first
 * and the write is retried. A student with a dozen open problems loses the
 * oldest one rather than the newest.
 */
async function setWithEviction(items: Record<string, unknown>, attempts = 4): Promise<void> {
  try {
    await area().set(items);
  } catch (err) {
    if (attempts <= 0 || !/quota/i.test(String((err as Error)?.message ?? err))) throw err;
    const writing = new Set(Object.keys(items).map((k) => parseKey(k)?.tabId));
    const all = await area().get(null);
    const oldest = Object.entries(all)
      .map(([k, v]) => ({ key: parseKey(k), updatedAt: (v as Chat)?.updatedAt ?? 0 }))
      .filter((e) => e.key?.kind === 'chat' && !writing.has(e.key.tabId))
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest?.key) throw err;
    await clearThread(oldest.key.tabId);
    await setWithEviction(items, attempts - 1);
  }
}

/**
 * The conversation so far, in the shape the model wants as history: only
 * complete question-and-answer pairs. A question whose answer failed or was
 * stopped empty is dropped along with it, so roles always alternate —
 * Anthropic's API rejects two user turns in a row, and a dangling question
 * would be answered twice.
 */
export function historyOf(turns: Turn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (let i = 0; i < turns.length - 1; i++) {
    const q = turns[i]!;
    const a = turns[i + 1]!;
    if (q.role !== 'user' || a.role !== 'assistant') continue;
    if (a.error || a.streaming || !a.text.trim()) continue;
    out.push({ role: 'user', text: q.text }, { role: 'assistant', text: a.text });
    i++;
  }
  return out;
}
