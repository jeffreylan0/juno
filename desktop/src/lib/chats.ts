/**
 * Chats: one conversation can collect selections from any number of pages.
 *
 * A chat is a timeline of items — selections as they arrive, the student's
 * questions, the model's answers. Each question takes every selection that
 * has not yet been answered with it, so "select, select, ask" sends both.
 * The first selection starts a chat; finishing it (✕ or Escape) leaves it in
 * the chat menu (current.ts has the rules).
 *
 * Where things live:
 *  - saved chats: storage.local, one key per chat plus a small index for the
 *    menu. The student picks how many are kept (Settings.chatLimit). With
 *    an account that has cloud storage, account/sync.ts keeps a copy of
 *    each in the cloud as well.
 *  - temporary chats: storage.session (memory only). Never listed, and
 *    deleted when the panel closes.
 *  - screenshots: files (images.ts), referenced from the chat; a temporary
 *    chat's stay in memory.
 *
 * The core is the only writer. The panel renders whatever is stored and
 * hears about changes through storage events.
 */
import type { Attachment, ChatTurn, ModelRef, Plan, Usage } from '@shared/payload';
import { deleteChatImages, images } from './images';
import { getSettings } from './storage';

export interface SelectionItem {
  kind: 'selection';
  id: string;
  at: number;
  plan: Plan;
  /** Why this selection cannot be used (the screenshot failed). */
  notice?: string;
}

export interface UserItem {
  kind: 'user';
  id: string;
  at: number;
  text: string;
  /** The selections sent with this question. */
  selections: string[];
}

export interface AssistantItem {
  kind: 'assistant';
  id: string;
  at: number;
  text: string;
  streaming?: boolean;
  usage?: Usage;
  model?: ModelRef;
  error?: string;
  /** The error's category (providers/errors.ts), so the panel can offer a fix. */
  errorCode?: string;
}

export type ChatItem = SelectionItem | UserItem | AssistantItem;

export interface Chat {
  id: string;
  title: string;
  /** Renamed by the student, so later selections do not retitle it. */
  titleEdited?: boolean;
  temporary?: boolean;
  createdAt: number;
  /** When it was last used: the menu's order, and what the limit keeps. */
  updatedAt: number;
  /**
   * When anything in it last changed (a rename, an answer), for the cloud
   * copy: the newer version wins. Older chats have none; updatedAt stands in.
   */
  editedAt?: number;
  items: ChatItem[];
}

/** The chat's version, for the cloud copy. */
export const versionOf = (chat: Pick<Chat, 'editedAt' | 'updatedAt'>): number => chat.editedAt ?? chat.updatedAt;

/** What the chat menu lists and searches, without loading every chat. */
export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Lower-case title, page titles and questions, for the menu's search. */
  search: string;
}

export const chatKey = (id: string) => `chat:${id}`;
export const INDEX_KEY = 'chatIndex';

type Area = chrome.storage.StorageArea;
const local = (): Area => (browser.storage as unknown as { local: Area }).local;
const session = (): Area => (browser.storage as unknown as { session: Area }).session;
const areaFor = (chat: Pick<Chat, 'temporary'>) => (chat.temporary ? session() : local());

export function newChat(temporary = false, id: string = crypto.randomUUID()): Chat {
  const now = Date.now();
  return { id, title: '', ...(temporary ? { temporary: true } : {}), createdAt: now, updatedAt: now, items: [] };
}

export async function getChat(id: string): Promise<Chat | null> {
  const key = chatKey(id);
  const saved = (await local().get(key))[key] as Chat | undefined;
  if (saved) return saved;
  return ((await session().get(key))[key] as Chat | undefined) ?? null;
}

export async function listChats(): Promise<ChatSummary[]> {
  return (((await local().get(INDEX_KEY))[INDEX_KEY] as ChatSummary[] | undefined) ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface SaveOptions {
  /** Move it to the top of the menu (default). Streaming writes and renames do not. */
  touch?: boolean;
  /** Rewrite the menu's entry (default). Streaming writes skip it: they change only the answer. */
  index?: boolean;
}

/**
 * Writes a chat. An empty chat is never written: a chat exists once it has
 * something in it. Saving past the student's limit drops the least recently
 * used chats, screenshots and all; they are returned so the student can be told.
 */
export async function saveChat(chat: Chat, opts: SaveOptions = {}): Promise<{ chat: Chat; dropped: ChatSummary[] }> {
  const { touch = true, index = true } = opts;
  if (!chat.items.length) return { chat, dropped: [] };
  const now = Date.now();
  const next: Chat = {
    ...chat,
    ...(touch ? { updatedAt: now } : {}),
    ...(chat.temporary ? {} : { editedAt: Math.max(now, versionOf(chat) + 1) }),
  };
  await areaFor(next).set({ [chatKey(next.id)]: next });
  if (next.temporary || !index) return { chat: next, dropped: [] };

  const list = (await listChats()).filter((c) => c.id !== next.id);
  list.push(summarize(next));
  const dropped = await overLimit(list);
  await local().set({ [INDEX_KEY]: list });
  for (const c of dropped) await discardChat(c.id);
  return { chat: next, dropped };
}

/**
 * Keeps the newest chats up to the limit and deletes the rest. Run whenever
 * settings change, so a lowered limit (the settings page asks first) takes
 * effect at once; returns what went, and writes nothing when nothing did.
 */
export async function pruneChats(): Promise<ChatSummary[]> {
  const list = await listChats();
  const dropped = await overLimit(list);
  if (!dropped.length) return [];
  await local().set({ [INDEX_KEY]: list });
  for (const c of dropped) await discardChat(c.id);
  return dropped;
}

/** Sorts `list` newest first and takes off (and returns) whatever is past the limit. */
async function overLimit(list: ChatSummary[]): Promise<ChatSummary[]> {
  const { chatLimit } = await getSettings();
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.splice(chatLimit);
}

/**
 * Read, change, write. Returns null (and writes nothing) when the chat is
 * gone — deleted, or a temporary chat whose panel closed — so a late write
 * from a streaming answer can never bring it back.
 */
export async function updateChat(
  id: string,
  change: (chat: Chat) => Chat,
  opts: SaveOptions = {},
): Promise<{ chat: Chat; dropped: ChatSummary[] } | null> {
  const chat = await getChat(id);
  if (!chat) return null;
  return await saveChat(change(chat), opts);
}

/**
 * The student deleted these chats (not the limit, not a temporary chat
 * ending): the cloud copy is deleted too. account/sync.ts listens.
 */
type DeletedListener = (ids: string[]) => void;
const deletedListeners = new Set<DeletedListener>();
export function onChatsDeleted(fn: DeletedListener): () => void {
  deletedListeners.add(fn);
  return () => deletedListeners.delete(fn);
}
const deleted = (ids: string[]) => ids.length && deletedListeners.forEach((fn) => fn(ids));

export async function deleteChat(id: string): Promise<void> {
  const index = (await listChats()).filter((c) => c.id !== id);
  await local().set({ [INDEX_KEY]: index });
  await discardChat(id);
  deleted([id]);
}

export async function renameChat(id: string, title: string): Promise<void> {
  const chat = await getChat(id);
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!chat || chat.temporary || !clean) return;
  await saveChat({ ...chat, title: clean, titleEdited: true }, { touch: false });
}

/** Removes every saved chat and its screenshots (the settings page's "Delete all chats"). */
export async function deleteAllChats(): Promise<void> {
  const list = await listChats();
  for (const c of list) await discardChat(c.id);
  await local().set({ [INDEX_KEY]: [] });
  deleted(list.map((c) => c.id));
}

/** A saved chat, from this computer only (never a temporary one). */
export async function getSavedChat(id: string): Promise<Chat | null> {
  const key = chatKey(id);
  return ((await local().get(key))[key] as Chat | undefined) ?? null;
}

/**
 * Whether a chat last used at `updatedAt` would be kept under the limit,
 * so the cloud does not download one only to drop it.
 */
export async function wouldKeep(id: string, updatedAt: number): Promise<boolean> {
  const list = (await listChats()).filter((c) => c.id !== id);
  const { chatLimit } = await getSettings();
  return list.length < chatLimit || updatedAt > (list[chatLimit - 1]?.updatedAt ?? 0);
}

/**
 * Writes a chat that came from the cloud, as it came (no new version), and
 * keeps the limit. Returns what the limit dropped.
 */
export async function putSyncedChat(chat: Chat): Promise<ChatSummary[]> {
  const clean: Chat = { ...chat, temporary: undefined };
  delete clean.temporary;
  const list = (await listChats()).filter((c) => c.id !== chat.id);
  list.push(summarize(clean));
  const dropped = await overLimit(list);
  if (!dropped.some((d) => d.id === chat.id)) await local().set({ [chatKey(chat.id)]: clean });
  await local().set({ [INDEX_KEY]: list });
  for (const c of dropped) await discardChat(c.id);
  return dropped;
}

/** Removes a chat another computer deleted (no tombstone back: it is one). */
export async function removeSyncedChat(id: string): Promise<boolean> {
  const list = await listChats();
  if (!list.some((c) => c.id === id) && !(await getSavedChat(id))) return false;
  await local().set({ [INDEX_KEY]: list.filter((c) => c.id !== id) });
  await discardChat(id);
  return true;
}

/** Removes a chat's data without touching the menu: a temporary chat, or one already unlisted. */
export async function discardChat(id: string): Promise<void> {
  await local().remove(chatKey(id));
  await session().remove(chatKey(id));
  await deleteChatImages(id);
}

/**
 * Screenshots nobody points at any more (a temporary chat left behind by a
 * crash, a crash mid-delete) are swept on start-up.
 */
export async function sweepImages(keep: Iterable<string> = []): Promise<void> {
  const live = new Set([...(await listChats()).map((c) => c.id), ...keep]);
  const sessionAll = await session().get(null);
  for (const key of Object.keys(sessionAll)) if (key.startsWith('chat:')) live.add(key.slice(5));
  for (const id of await images().chatIds()) if (!live.has(id)) await images().deleteForChat(id);
}

/**
 * Answers left "streaming" by an app that quit mid-answer. Run on
 * start-up, when nothing can be streaming, so no chat shows a spinner (and a
 * Stop button) forever. What arrived is kept.
 */
export async function settleStreaming(): Promise<void> {
  const ids = [...(await listChats()).map((c) => c.id)];
  const sessionAll = await session().get(null);
  for (const key of Object.keys(sessionAll)) if (key.startsWith('chat:')) ids.push(key.slice(5));
  for (const id of new Set(ids)) {
    const chat = await getChat(id);
    if (!chat?.items.some((i) => i.kind === 'assistant' && i.streaming)) continue;
    const items = chat.items.map((i) =>
      i.kind === 'assistant' && i.streaming
        ? { ...i, streaming: false, ...(i.text.trim() ? {} : { error: 'Stopped before an answer arrived.' }) }
        : i,
    );
    await saveChat({ ...chat, items }, { touch: false, index: false });
  }
}

/** A chat's title: its first selection's page, until the student renames it. */
export function autoTitle(plan: Plan): string {
  const title = plan.page.title.replace(/\s+/g, ' ').trim();
  if (title) return title.length > 80 ? `${title.slice(0, 79)}…` : title;
  try {
    return new URL(plan.page.url).hostname || 'New chat';
  } catch {
    return 'New chat';
  }
}

export function withSelection(chat: Chat, item: SelectionItem): Chat {
  return retitle({ ...chat, items: [...chat.items, item] });
}

/** Named after its first selection's page, unless the student renamed it. */
export function retitle(chat: Chat): Chat {
  if (chat.titleEdited) return chat;
  const first = chat.items.find((i): i is SelectionItem => i.kind === 'selection');
  return { ...chat, title: first ? autoTitle(first.plan) : '' };
}

/** Whether a selection can still be taken back: no question has carried it yet. */
export function isRemovable(chat: Chat, selectionId: string): boolean {
  return !chat.items.some((i) => i.kind === 'user' && i.selections.includes(selectionId));
}

const answered = (a: ChatItem | undefined): a is AssistantItem =>
  a?.kind === 'assistant' && !a.error && !a.streaming && !!a.text.trim();

/** Ids of selections already sent with a question that got an answer. */
function sentSelections(items: ChatItem[]): Set<string> {
  const sent = new Set<string>();
  items.forEach((item, i) => {
    if (item.kind === 'user' && answered(items[i + 1])) item.selections.forEach((id) => sent.add(id));
  });
  return sent;
}

/**
 * Selections the next question will carry: every usable one not yet
 * answered — including any whose question failed, so a retry or a new
 * question still sends them.
 */
export function pendingSelections(chat: Chat): SelectionItem[] {
  const sent = sentSelections(chat.items);
  return chat.items.filter(
    (i): i is SelectionItem => i.kind === 'selection' && !i.notice && i.plan.parts.length > 0 && !sent.has(i.id),
  );
}

/** Whether the chat has anything to ask about. */
export function hasUsableSelection(chat: Chat | null): boolean {
  return !!chat?.items.some((i) => i.kind === 'selection' && !i.notice && i.plan.parts.length > 0);
}

export function attachmentOf(item: SelectionItem): Attachment {
  const { plan } = item;
  return { kind: plan.selection.kind, page: plan.page, parts: plan.parts };
}

/**
 * The conversation so far, as the model wants it: complete question-and-
 * answer pairs only, each question with the selections it carried. A failed
 * or empty answer drops out with its question, so roles always alternate
 * (Anthropic rejects two user turns in a row) and nothing is answered twice.
 */
export function historyOf(chat: Chat): ChatTurn[] {
  const byId = new Map(chat.items.filter((i): i is SelectionItem => i.kind === 'selection').map((s) => [s.id, s]));
  const out: ChatTurn[] = [];
  chat.items.forEach((item, i) => {
    if (item.kind !== 'user') return;
    const answer = chat.items[i + 1];
    if (!answered(answer)) return;
    const attachments = item.selections.map((id) => byId.get(id)).filter((s): s is SelectionItem => !!s).map(attachmentOf);
    out.push({ role: 'user', text: item.text, ...(attachments.length ? { attachments } : {}) }, { role: 'assistant', text: answer.text });
  });
  return out;
}

/** The newest selection in a chat, for tests and diagnostics. */
export function latestSelection(chat: Chat | null): SelectionItem | undefined {
  return chat?.items.filter((i): i is SelectionItem => i.kind === 'selection').at(-1);
}

function summarize(chat: Chat): ChatSummary {
  const pages = chat.items.flatMap((i) => (i.kind === 'selection' ? [i.plan.page.title] : []));
  const questions = chat.items.flatMap((i) => (i.kind === 'user' ? [i.text] : []));
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    search: [chat.title, ...pages, ...questions].join('\n').toLowerCase().slice(0, 4000),
  };
}
