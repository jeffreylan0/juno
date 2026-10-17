/**
 * The chat engine: the part of the background that does not care where it
 * runs. The extension's service worker and the desktop app's hidden core
 * window each own one, and both are the only writer of chats in their world.
 *
 * It keeps the one-write-at-a-time queue (`serial`), the answers streaming
 * (one per chat), the cloud copy, and the AI's connection status. What a
 * selection is and how it was captured, which tab or display it came from,
 * and how the bar and the panel are shown are the host's business.
 */
import type { AskRequest, Attachment, ChatTurn } from '@shared/payload';
import { deleteAccount } from './account/cloud';
import { currentSession, sessionItem } from './account/session';
import { ChatSync } from './account/sync';
import {
  attachmentOf,
  deleteAllChats,
  deleteChat,
  discardChat,
  getChat,
  hasUsableSelection,
  historyOf,
  isRemovable,
  latestSelection,
  listChats,
  pendingSelections,
  pruneChats,
  renameChat,
  retitle,
  saveChat,
  settleStreaming,
  sweepImages,
  updateChat,
  type AssistantItem,
  type Chat,
  type ChatItem,
  type ChatSummary,
  type SelectionItem,
  type UserItem,
} from './chats';
import { addSelection, allCurrent, discardOrphans, onTemporaryDiscarded, replaceGone, type Current } from './current';
import { deletePartImages, hydrateParts, hydratePlan } from './images';
import type { RuntimeMessage, SelectionDoneMsg } from './messages';
import { buildPlan, type CaptureResult } from './planner';
import { callModel, type ProviderContext } from './providers';
import { testKey } from './providers/byok';
import { chooseRoute } from './router';
import { STATUS_KEY, STATUS_TTL_MS, checkStatus, statusFromAnswer, type AiStatus } from './status';
import {
  DEFAULT_SETTINGS,
  GATEWAY_URL,
  answerChoiceOf,
  fallbackQuestion,
  getKeys,
  getSettings,
  keysItem,
  settingsItem,
  shouldAutoSend,
  type Keys,
  type Settings,
} from './storage';

/** How often a streaming answer is written back to its chat. */
const STREAM_SAVE_MS = 120;

/** Replies once the work is done, whether it worked or not (null if it threw). */
export function reply(work: Promise<unknown>, sendResponse: (value: unknown) => void): true {
  work.then(
    (value) => sendResponse(value ?? true),
    (err) => {
      console.warn('[selection-ai] command failed', err);
      sendResponse(null);
    },
  );
  return true;
}

/** The messages the extension's background and the app's core answer alike (ChatEngine.handle). */
const SHARED: ReadonlySet<string> = new Set([
  'plan:get',
  'chat:send',
  'chat:retry',
  'chat:stop',
  'chat:rename',
  'chat:delete',
  'chats:delete-all',
  'chat:drop-selection',
  'ai:check',
  'keys:test',
  'sync:now',
  'account:delete',
]);

export interface EngineHost {
  /** Where answers, connection checks and key checks go out. */
  fetch: typeof fetch;
  /** Whether any panel is open: the connection is only worth re-checking then. */
  panelsOpen(): boolean;
}

/**
 * A crop, and — from the desktop app, which only learns it at capture time —
 * the window it was taken from, which then names the selection's page.
 */
export type KeptCapture = CaptureResult & { page?: { url: string; title: string } };

/** A selection to keep: what was selected, and how to get its screenshot (none for text). */
export interface KeepInput {
  selection: SelectionDoneMsg;
  windowId: number;
  /** The chat it was made for, fixed when it was committed (current.ts). */
  into: Promise<Current>;
  /** The crop, or undefined for text. A throw becomes the selection's notice. */
  capture: () => Promise<KeptCapture | undefined>;
  tabId?: number;
}

const sharedSession = () => (browser.storage as unknown as { session: chrome.storage.StorageArea }).session;

export class ChatEngine {
  /**
   * Settings, cached, for whatever must be answered before any await (the
   * extension's toolbar click). Kept fresh by start().
   */
  settings: Settings = DEFAULT_SETTINGS;
  /** Cloud copies of saved chats, for accounts that have them (account/sync.ts). */
  sync: ChatSync | null = null;
  /** One answer at a time per chat. */
  private streams = new Map<string, AbortController>();
  private tail: Promise<unknown> = Promise.resolve();
  private checking: { key: string; run: Promise<AiStatus> } | null = null;

  constructor(private host: EngineHost) {}

  /**
   * Starts watching settings, keys and the account, tidies what a stopped
   * run left behind, and starts the cloud copy. Call once, from the host's
   * main (never at module level: WXT evaluates entrypoints at build time).
   */
  start(): this {
    void getSettings().then((s) => (this.settings = s));
    settingsItem.watch(() =>
      void getSettings().then((s) => {
        const before = `${answerChoiceOf(this.settings)} ${this.settings.localBaseUrl}`;
        this.settings = s;
        // Picking another model: check the new choice right away.
        if (this.host.panelsOpen() && before !== `${answerChoiceOf(s)} ${s.localBaseUrl}`) void this.aiStatus(true);
        // Keeping fewer chats (the settings page asked first): the oldest go
        // now. Checked on every change, since a worker that was asleep cannot
        // tell a lowered limit from the one it just read.
        void this.serial(async () => {
          const dropped = await pruneChats();
          await replaceGone(dropped.map((c) => c.id));
          await this.noteDropped(dropped);
        });
      }),
    );
    keysItem.watch(() => void (this.host.panelsOpen() && this.aiStatus(true)));
    // Signing in or out changes whether hosted answers can be asked.
    sessionItem.watch((now, before) => {
      if (now?.user.id !== before?.user.id && this.settings.provider === 'gateway' && this.host.panelsOpen()) void this.aiStatus(true);
    });

    // A temporary chat's answer is not worth finishing (or paying for) once the
    // chat is gone, however it went: ✕ on the bar, the ghost, another chat opened.
    onTemporaryDiscarded((id) => this.stopStream(id));
    void this.serial(settleStreaming);
    this.sync = new ChatSync({
      serial: (task) => this.serial(task),
      gone: async (ids) => {
        ids.forEach((id) => this.stopStream(id));
        await this.serial(() => replaceGone(ids));
      },
    }).start();
    // A temporary chat left behind, screenshots nobody points at: tidied once,
    // after any panel that is still open has had a moment to reconnect.
    setTimeout(() => {
      void this.serial(async () => {
        await discardOrphans();
        await sweepImages((await allCurrent()).map(([, c]) => c.chatId));
      });
    }, 3_000);
    return this;
  }

  /**
   * Every chat write goes through here, one after another. A streaming answer,
   * a selection arriving and the panel closing all read and rewrite the same
   * chat; in sequence, none of them undoes another.
   */
  serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.catch((err) => console.warn('[selection-ai] chat write failed', err));
    return run;
  }

  stopStream(chatId: string): void {
    this.streams.get(chatId)?.abort();
    this.streams.delete(chatId);
  }

  /** Stops the answer streaming in a chat, keeping what arrived (the panel's Stop). */
  abortStream(chatId: string): void {
    this.streams.get(chatId)?.abort();
  }

  /** Whether handle() answers this message. */
  handles(msg: RuntimeMessage): boolean {
    return SHARED.has(msg.type);
  }

  /**
   * Answers the messages the extension and the app share: chats, the AI's
   * status and key checks, the cloud copy, the account. Returns what an
   * onMessage listener returns (true: the reply comes later).
   */
  handle(msg: RuntimeMessage, sendResponse: (value: unknown) => void): true | undefined {
    const serial = <T>(task: () => Promise<T>) => this.serial(task);
    switch (msg.type) {
      case 'plan:get':
        void this.planFor(msg.tabId).then(sendResponse);
        return true;
      case 'chat:send':
        void this.sendChat(msg.chatId, msg.question);
        return;
      case 'chat:retry':
        void this.retryChat(msg.chatId);
        return;
      case 'chat:stop':
        this.abortStream(msg.chatId);
        return;
      case 'chat:rename':
        return reply(serial(() => renameChat(msg.chatId, msg.title)), sendResponse);
      case 'chat:delete':
        this.stopStream(msg.chatId);
        return reply(
          serial(async () => {
            await deleteChat(msg.chatId);
            await replaceGone([msg.chatId]);
          }),
          sendResponse,
        );
      case 'chats:delete-all':
        return reply(
          serial(async () => {
            const ids = (await listChats()).map((c) => c.id);
            ids.forEach((id) => this.stopStream(id));
            await deleteAllChats();
            await this.sync?.deleteAll();
            await replaceGone(ids);
          }),
          sendResponse,
        );
      case 'chat:drop-selection':
        return reply(serial(() => this.dropSelection(msg.chatId, msg.itemId)), sendResponse);
      case 'ai:check':
        return reply(this.aiStatus(!!msg.force), sendResponse);
      case 'keys:test':
        void testKey(this.host.fetch, msg.vendor, msg.key).then(sendResponse);
        return true;
      case 'sync:now':
        this.sync?.soon(0);
        return;
      case 'account:delete':
        void (async () => {
          const s = await currentSession();
          if (!s) return { error: 'Signed out already.' };
          const resume = await this.sync?.pause();
          try {
            await deleteAccount(s.user.id);
            await this.sync?.reset();
          } finally {
            resume?.();
          }
          return { ok: true };
        })()
          .catch((err: Error) => ({ error: err.message }))
          .then(sendResponse);
        return true;
    }
  }

  /** The chat limit dropped a chat: tell the panels, once. */
  async noteDropped(dropped: ChatSummary[]): Promise<void> {
    if (!dropped.length) return;
    for (const c of dropped) this.stopStream(c.id);
    await sharedSession().set({ lastDropped: { titles: dropped.map((c) => c.title || 'Untitled chat'), at: Date.now() } });
  }

  /** The keys an answer or a check needs; for hosted answers, the account's current token. */
  async keysFor(current: Settings): Promise<Keys> {
    const keys = await getKeys();
    if (current.provider !== 'gateway') return { ...keys, session: '' };
    return { ...keys, session: (await currentSession())?.accessToken ?? '' };
  }

  /**
   * A selection arrived and its screenshot is (being) taken: it is cropped,
   * joins the chat it was made for, and is asked about at once if settings say
   * so. Resolves with that chat, or null if the chat was finished or deleted
   * meanwhile. Asking waits for the host's `beforeAsk` (the extension offers a
   * click to open its panel there).
   */
  async keepSelection(input: KeepInput, beforeAsk?: () => Promise<void>): Promise<Chat | null> {
    const { selection: msg, windowId, tabId } = input;
    const current = await getSettings();
    let capture: KeptCapture | undefined;
    let notice: string | undefined;
    try {
      capture = await input.capture();
    } catch (err) {
      console.warn('[selection-ai] capture failed', err);
      // A box is only its screenshot now, so without one there is nothing
      // to send. Say so, rather than quietly asking about nothing.
      notice = captureNotice(err);
    }
    const selection = capture?.page ? { ...msg, page: capture.page } : msg;
    const plan = buildPlan({ selection, mode: 'ask', capture });
    // The selection joins the chat it was made for, whatever page it came
    // from; an answer still streaming there carries on.
    let added: Awaited<ReturnType<typeof addSelection>>;
    try {
      const target = await input.into;
      added = await this.serial(() => addSelection(windowId, { plan, notice, tabId, into: target }));
    } catch (err) {
      console.warn('[selection-ai] could not keep the selection', err);
      return null;
    }
    if (!added) return null; // its chat was finished or deleted meanwhile
    const { chat, dropped } = added;
    await this.noteDropped(dropped);

    await beforeAsk?.();
    const usable = !notice && plan.parts.length > 0;
    // Auto-send waits its turn: an answer already streaming is not cut off.
    if (usable && shouldAutoSend(current) && !this.streams.has(chat.id)) void this.sendChat(chat.id, fallbackQuestion(current));
    return chat;
  }

  /**
   * The newest selection in the chats open right now — from one tab when a tab
   * is given — with its screenshots filled back in. For tests and diagnostics.
   */
  async planFor(tabId: number | undefined) {
    const chats = await Promise.all((await allCurrent()).map(([, c]) => getChat(c.chatId)));
    const newest = chats
      .flatMap((c) => c?.items ?? [])
      .filter((i): i is SelectionItem => i.kind === 'selection' && (tabId === undefined || i.tabId === tabId))
      .sort((a, b) => b.at - a.at)[0];
    return newest ? await hydratePlan(newest.plan) : null;
  }

  /**
   * Asks a question in a chat. It carries every selection made since the last
   * answered question (select, select, ask sends both); earlier questions go
   * along as history, each with the selections it carried. The answer streams
   * into the chat, so it survives the panel closing and shows in the menu.
   */
  async sendChat(chatId: string, question: string): Promise<void> {
    if (this.streams.has(chatId)) return; // one answer at a time; the panel shows Stop meanwhile
    const controller = new AbortController();
    this.streams.set(chatId, controller);

    let answerId = '';
    let text = '';
    const finish = (done: Partial<AssistantItem>, opts = { touch: false, index: false }) =>
      this.serial(() =>
        updateChat(
          chatId,
          (c) => ({ ...c, items: c.items.map((i) => (i.id === answerId && i.kind === 'assistant' ? { ...i, text, ...done } : i)) }),
          opts,
        ),
      );

    try {
      const setup = await this.serial(async () => {
        const chat = await getChat(chatId);
        if (!chat || !hasUsableSelection(chat)) return null;
        const settled: Chat = { ...chat, items: chat.items.map(settle) };
        const pending = pendingSelections(settled);
        const q = question.trim() || fallbackQuestion(this.settings);
        const user: UserItem = { kind: 'user', id: crypto.randomUUID(), at: Date.now(), text: q, selections: pending.map((s) => s.id) };
        const answer: AssistantItem = { kind: 'assistant', id: crypto.randomUUID(), at: Date.now(), text: '', streaming: true };
        const saved = await saveChat({ ...settled, items: [...settled.items, user, answer] });
        await replaceGone(saved.dropped.map((c) => c.id));
        await this.noteDropped(saved.dropped);
        return { chat: settled, pending, q, answerId: answer.id, temporary: !!chat.temporary };
      });
      if (!setup) return;
      answerId = setup.answerId;

      const attachments = await Promise.all(setup.pending.map((s) => withPixels(attachmentOf(s))));
      const history: ChatTurn[] = await Promise.all(
        historyOf(setup.chat).map(async (t) => (t.attachments ? { ...t, attachments: await Promise.all(t.attachments.map(withPixels)) } : t)),
      );
      const latest = setup.pending.at(-1) ?? latestSelection(setup.chat)!;
      // Anything with a screenshot anywhere in the chat goes to the large model.
      const everything = [...history.flatMap((t) => t.attachments ?? []), ...attachments].flatMap((a) => a.parts);
      const route = chooseRoute({ parts: everything, mode: 'ask', question: setup.q });
      const request: AskRequest = {
        plan: { ...latest.plan, parts: attachments.flatMap((a) => a.parts), question: setup.q, route },
        attachments,
        history,
      };

      let dirty = false;
      const timer = setInterval(() => {
        if (!dirty) return;
        dirty = false;
        void finish({ streaming: true });
      }, STREAM_SAVE_MS);

      const done: Partial<AssistantItem> = { streaming: false };
      const current = await getSettings();
      const keys = await this.keysFor(current);
      try {
        const ctx: ProviderContext = {
          fetch: this.host.fetch,
          keys,
          settings: { ...current, gatewayUrl: GATEWAY_URL },
          // A temporary chat asks the vendor to keep as little as it allows.
          ephemeral: setup.temporary,
          signal: controller.signal,
        };
        for await (const chunk of callModel(request, route, ctx, {
          provider: current.provider,
          vendor: current.vendor,
          model: current.modelOverride,
        })) {
          if (chunk.type === 'delta') {
            text += chunk.text;
            dirty = true;
          } else if (chunk.type === 'done') {
            Object.assign(done, { usage: chunk.usage, model: chunk.model });
            void this.recordStatus(current, { ok: true });
          } else if (chunk.code === 'aborted') {
            // A stop keeps whatever arrived; only an empty stop needs saying.
            if (!text.trim()) done.error = 'Stopped before an answer arrived.';
          } else {
            done.error = chunk.message;
            done.errorCode = chunk.code;
            void this.recordStatus(current, { ok: false, code: chunk.code, message: chunk.message });
          }
        }
      } catch (err) {
        done.error = (err as Error).message;
      } finally {
        clearInterval(timer);
      }
      await finish(done, { touch: true, index: true });
    } catch (err) {
      console.warn('[selection-ai] ask failed', err);
      if (answerId) await finish({ streaming: false, error: (err as Error).message }, { touch: true, index: true });
    } finally {
      if (this.streams.get(chatId) === controller) this.streams.delete(chatId);
    }
  }

  /**
   * Try again after a failed answer: the failed question and its error are
   * dropped and the question is asked afresh — with the same selections, since
   * they were never answered.
   */
  async retryChat(chatId: string): Promise<void> {
    if (this.streams.has(chatId)) return;
    const question = await this.serial(async () => {
      const chat = await getChat(chatId);
      const answer = chat?.items.at(-1);
      const asked = chat?.items.at(-2);
      if (!chat || answer?.kind !== 'assistant' || !answer.error || asked?.kind !== 'user') return null;
      await saveChat({ ...chat, items: chat.items.slice(0, -2) }, { touch: false });
      return asked.text;
    });
    if (question !== null) await this.sendChat(chatId, question);
  }

  /** A selection taken back before any question carried it. */
  async dropSelection(chatId: string, itemId: string): Promise<void> {
    const chat = await getChat(chatId);
    const item = chat?.items.find((i): i is SelectionItem => i.kind === 'selection' && i.id === itemId);
    if (!chat || !item || !isRemovable(chat, itemId)) return;
    await deletePartImages(item.plan.parts);
    const next = retitle({ ...chat, items: chat.items.filter((i) => i.id !== itemId) });
    if (next.items.length) await saveChat(next, { touch: false });
    else if (chat.temporary) await discardChat(chatId);
    else await deleteChat(chatId); // an empty chat is not kept; the window stays on it, empty
  }

  /**
   * The chosen AI's status, from a check at most a minute old unless `force`.
   * One check at a time per choice and key: a panel opening in each of three
   * windows asks once, and a check for an old choice or key is never passed off
   * as one for the new.
   */
  async aiStatus(force: boolean): Promise<AiStatus> {
    const current = await getSettings();
    const keys = await this.keysFor(current);
    const choice = answerChoiceOf(current);
    // In memory only; the key is part of it so a fixed key (or a new sign-in) is checked afresh.
    const key = `${choice}|${current.localBaseUrl}|${current.provider === 'byok' ? keys[current.vendor] : current.provider === 'gateway' ? keys.session.slice(-16) : ''}`;
    if (this.checking?.key === key) return await this.checking.run;
    const stored = (await sharedSession().get(STATUS_KEY))[STATUS_KEY] as AiStatus | undefined;
    if (!force && stored && stored.choice === choice && Date.now() - stored.checkedAt < STATUS_TTL_MS) return stored;

    const before = this.checking?.run ?? Promise.resolve();
    const run = before
      .catch(() => undefined)
      .then(async () => {
        let status: AiStatus;
        try {
          status = await checkStatus(this.host.fetch, current, keys);
        } catch (err) {
          status = { state: 'error', choice, who: '', message: (err as Error).message, checkedAt: Date.now() };
        }
        await sharedSession().set({ [STATUS_KEY]: status });
        return status;
      });
    this.checking = { key, run };
    const done = () => {
      if (this.checking?.run === run) this.checking = null;
    };
    run.then(done, done);
    return await run;
  }

  /** What an answer proved about the connection, if anything. */
  async recordStatus(current: Settings, outcome: Parameters<typeof statusFromAnswer>[1]): Promise<void> {
    const status = statusFromAnswer(current, outcome);
    if (status) await sharedSession().set({ [STATUS_KEY]: status });
  }
}

/** What a selection says when its screenshot could not be taken. */
function captureNotice(err: unknown): string {
  // A host can explain itself (the app: permission missing); the extension's crop errors cannot.
  const message = (err as { notice?: unknown } | null)?.notice;
  return typeof message === 'string' && message ? message : "Couldn't take a screenshot of that. Try again, or reload the page.";
}

async function withPixels(a: Attachment): Promise<Attachment> {
  return { ...a, parts: await hydrateParts(a.parts) };
}

/**
 * An answer left streaming when the worker was stopped mid-answer. It keeps
 * whatever text arrived, and is marked stopped so it stops showing a spinner
 * (and, if empty, drops out of the history sent to the model).
 */
function settle(item: ChatItem): ChatItem {
  if (item.kind !== 'assistant' || !item.streaming) return item;
  return { ...item, streaming: false, error: item.text.trim() ? item.error : 'Stopped before an answer arrived.' };
}
