/**
 * Background (MV3 service worker on Chrome/Edge, background script on Firefox).
 * Arms selections, captures the tab, runs the planner, and owns every chat.
 * Anything that holds keys or makes network calls lives here, never in the
 * content script.
 *
 * Clicking the toolbar action arms a selection immediately. By default the
 * answer panel opens once a selection is made, so it never covers the page
 * while the student is still choosing what to select; a setting opens it on
 * the click instead.
 *
 * Chats (lib/chats.ts) collect selections from any page in the window until
 * the panel closes; which chat a window shows, and what opening and closing
 * the panel does, is lib/current.ts. This file is the only writer, and it
 * writes one change at a time (`serial`), so a selection landing while an
 * answer streams is never overwritten by the stream's next write.
 */
import type { AskRequest, Attachment, ChatTurn, SelectionKind } from '@shared/payload';
import { AreaCacheStore } from '@/lib/cache';
import { captureRect, type CaptureResult } from '@/lib/capture';
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
} from '@/lib/chats';
import {
  addSelection,
  allCurrent,
  endUnclaimed,
  onTemporaryDiscarded,
  panelClosed,
  panelOpened,
  replaceGone,
  setTemporary,
  startChat,
  switchTo,
} from '@/lib/current';
import { deletePartImages, hydrateParts, hydratePlan } from '@/lib/images';
import {
  PANEL_PORT,
  isRuntimeMessage,
  type PanelPortMsg,
  type RuntimeMessage,
  type SelectionDoneMsg,
  type StartSelectionMsg,
} from '@/lib/messages';
import { buildPlan } from '@/lib/planner';
import { callModel, type ProviderContext } from '@/lib/providers';
import { testKey } from '@/lib/providers/byok';
import { chooseRoute } from '@/lib/router';
import { STATUS_KEY, STATUS_TTL_MS, checkStatus, statusFromAnswer, type AiStatus } from '@/lib/status';
import {
  DEFAULT_SETTINGS,
  GATEWAY_URL,
  answerChoiceOf,
  fallbackQuestion,
  getKeys,
  getSettings,
  keysItem,
  lastKindItem,
  settingsItem,
  shouldAutoSend,
  type Settings,
} from '@/lib/storage';

const CONTENT_SCRIPT = 'content-scripts/content.js';

const COMMAND_KINDS: Record<string, SelectionKind> = {
  'select-box': 'box',
  'select-text': 'text',
  'select-element': 'element',
  'select-freeform': 'freeform',
};
/** How often a streaming answer is written back to the thread. */
const STREAM_SAVE_MS = 120;

/** True when a plan is waiting and the panel could not be opened for it. */
let panelPending = false;
/**
 * The tab a selection is armed in. Aborting targets this rather than "the
 * active tab": the student can arm a selection and then switch tabs.
 */
let armedTabId: number | undefined;
/** True once the panel has been opened for the current arming. */
let panelOpenedForArm = false;
/** One answer at a time per chat. */
const streams = new Map<string, AbortController>();

function stopStream(chatId: string): void {
  streams.get(chatId)?.abort();
  streams.delete(chatId);
}

/**
 * Every chat write goes through here, one after another. A streaming answer,
 * a selection arriving and the panel closing all read and rewrite the same
 * chat; in sequence, none of them undoes another.
 */
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task);
  tail = run.catch((err) => console.warn('[selection-ai] chat write failed', err));
  return run;
}

/**
 * Answers a message once the work is done, whether it worked or not, so the
 * sender is never left waiting. Returns true: the listener's "reply later".
 */
function reply(work: Promise<unknown>, sendResponse: (value: unknown) => void): true {
  work.then(
    (value) => sendResponse(value ?? true),
    (err) => {
      console.warn('[selection-ai] command failed', err);
      sendResponse(null);
    },
  );
  return true;
}

/** Open panels, per window. Usually one; tests open the panel page as a tab too. */
const panels = new Map<number, Set<chrome.runtime.Port>>();
const panelOpenIn = (windowId: number) => (panels.get(windowId)?.size ?? 0) > 0;

/** The free plan's limit dropped a chat: tell the panels, once. */
async function noteDropped(dropped: ChatSummary[]): Promise<void> {
  if (!dropped.length) return;
  for (const c of dropped) stopStream(c.id);
  await browser.storage.session.set({ lastDropped: { titles: dropped.map((c) => c.title || 'Untitled chat'), at: Date.now() } });
}

/**
 * Settings, cached. The toolbar click has to call sidePanel.open() before any
 * await or Chrome drops the gesture, so "should the panel open now?" must be
 * answerable synchronously. On a cold start before the first read lands, the
 * default (open on selection) applies — which needs no answer at click time.
 */
let settings: Settings = DEFAULT_SETTINGS;

export default defineBackground(() => {
  // Inside main, not at module level: WXT evaluates entrypoint modules in Node
  // at build time, where there is no browser to read from.
  void getSettings().then((s) => (settings = s));
  settingsItem.watch(() =>
    void getSettings().then((s) => {
      const before = `${answerChoiceOf(settings)} ${settings.localBaseUrl}`;
      settings = s;
      // Picking another model: check the new choice right away.
      if (panels.size && before !== `${answerChoiceOf(s)} ${s.localBaseUrl}`) void aiStatus(true);
    }),
  );
  keysItem.watch(() => void (panels.size && aiStatus(true)));

  // A panel that closed while the worker was not running, a temporary chat
  // left behind, screenshots nobody points at: tidied once, after any panel
  // that is still open has had a moment to reconnect.
  // A temporary chat's answer is not worth finishing (or paying for) once the
  // chat is gone, however it went: panel closed, New chat, the ghost, another chat opened.
  onTemporaryDiscarded(stopStream);
  void serial(settleStreaming);
  setTimeout(() => void serial(async () => {
    await endUnclaimed(panelOpenIn);
    await sweepImages((await allCurrent()).map(([, c]) => c.chatId));
  }), 3_000);

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT) return;
    let windowId: number | undefined;
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as PanelPortMsg;
      if (msg?.type !== 'hello' || windowId !== undefined) return; // pings only keep us awake
      windowId = msg.windowId;
      const open = panels.get(windowId) ?? new Set();
      const first = open.size === 0;
      open.add(port);
      panels.set(windowId, open);
      setPanelPending(false);
      void serial(() => panelOpened(msg.windowId, { first, claim: msg.claim })).then(
        () => port.postMessage({ type: 'ready' }),
        () => port.postMessage({ type: 'ready' }),
      );
    });
    port.onDisconnect.addListener(() => {
      if (windowId === undefined) return;
      const open = panels.get(windowId);
      open?.delete(port);
      if (open?.size) return;
      panels.delete(windowId);
      const closed = windowId;
      void serial(() => panelClosed(closed));
    });
  });

  browser.action.onClicked.addListener((tab) => {
    arm(tab?.id);
    void lastKindItem.getValue().then((kind) => startSelection(tab?.id, kind));
  });

  // The main shortcut is bound to _execute_action, which arrives as
  // action.onClicked above. These are the optional per-mode shortcuts.
  browser.commands.onCommand.addListener((command, tab) => {
    const kind = COMMAND_KINDS[command];
    if (!kind) return;
    arm(tab?.id);
    void startSelection(tab?.id, kind);
  });

  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (!isRuntimeMessage(raw)) return;
    const msg: RuntimeMessage = raw;
    switch (msg.type) {
      case 'selection:arm':
        void activeTabId().then((id) => startSelection(id, msg.kind));
        return;
      case 'selection:abort':
        abortArmed();
        return;
      case 'selection:committed':
        // First statement, before any await: this is the drag's (or the
        // confirm click's) user activation, and Chrome only honours
        // sidePanel.open() while it is live.
        armedTabId = undefined;
        if (!panelOpenedForArm) void openPanel(sender.tab?.id);
        return;
      case 'selection:done':
        armedTabId = undefined;
        void handleSelectionDone(msg, sender.tab);
        return;
      case 'selection:cancel':
        armedTabId = undefined;
        if (msg.closePanel) closePanel(sender.tab?.windowId);
        return;
      case 'plan:get':
        void planFor(msg.tabId).then(sendResponse);
        return true;
      case 'chat:send':
        void sendChat(msg.chatId, msg.question);
        return;
      case 'chat:retry':
        void retryChat(msg.chatId);
        return;
      case 'chat:stop':
        streams.get(msg.chatId)?.abort();
        return;
      case 'chat:new':
        return reply(serial(() => startChat(msg.windowId, false)), sendResponse);
      case 'chat:temporary':
        return reply(serial(() => setTemporary(msg.windowId, msg.on)), sendResponse);
      case 'chat:open':
        return reply(serial(() => switchTo(msg.windowId, msg.chatId)), sendResponse);
      case 'chat:rename':
        return reply(serial(() => renameChat(msg.chatId, msg.title)), sendResponse);
      case 'chat:delete':
        stopStream(msg.chatId);
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
            ids.forEach(stopStream);
            await deleteAllChats();
            await replaceGone(ids);
          }),
          sendResponse,
        );
      case 'chat:drop-selection':
        return reply(serial(() => dropSelection(msg.chatId, msg.itemId)), sendResponse);
      case 'ai:check':
        return reply(aiStatus(!!msg.force), sendResponse);
      case 'keys:test':
        void testKey(globalThis.fetch.bind(globalThis), msg.vendor, msg.key).then(sendResponse);
        return true;
      case 'panel:open':
        // Sent from a click on the page's toast, which carries a real gesture.
        void openPanel(sender.tab?.id);
        return;
      case 'panel:ready':
        setPanelPending(false);
        return;
      case 'options:open':
        void browser.runtime.openOptionsPage();
        return;
      case 'reader:hello':
        // The reader cannot know its own tab id without the tabs permission,
        // and we cannot recognise it by URL for the same reason. One hello
        // settles both: we remember the tab, it learns its id from the reply.
        if (sender.tab?.id !== undefined) {
          readerTabs.add(sender.tab.id);
          sendResponse({ tabId: sender.tab.id });
        }
        return true;
      default:
        return;
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    readerTabs.delete(tabId);
  });

  // A window closing takes its panel with it; the port usually says so first.
  browser.windows.onRemoved.addListener((windowId) => {
    if (panelOpenIn(windowId)) return;
    void serial(() => panelClosed(windowId)).catch(() => {});
  });
});

/**
 * A fresh arming. With `panelOpen: on-click` the panel opens right here, on the
 * click's own gesture; otherwise it waits for the selection to be committed.
 */
function arm(tabId: number | undefined): void {
  panelOpenedForArm = false;
  if (settings.panelOpen === 'on-click') void openPanelForArm(tabId);
}

function abortArmed(): void {
  if (armedTabId === undefined) return;
  const target = armedTabId;
  armedTabId = undefined;
  if (isOwnPage(target)) void browser.runtime.sendMessage({ type: 'selection:abort', tabId: target }).catch(() => {});
  else void browser.tabs.sendMessage(target, { type: 'selection:abort' }).catch(() => {});
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

/**
 * Opens the answer panel. Chrome and Firefox both require a live user gesture
 * here; a refusal is recorded so the page can offer a click that carries one.
 */
async function openPanel(tabId: number | undefined): Promise<boolean> {
  try {
    if (import.meta.env.FIREFOX) {
      await (browser as unknown as { sidebarAction?: { open(): Promise<void> } }).sidebarAction?.open();
      setPanelPending(false);
      return true;
    }
    if (import.meta.env.SAFARI) return true; // overlay.ts renders the panel in-page
    const sp = (browser as unknown as { sidePanel?: { open(o: { tabId?: number; windowId?: number }): Promise<void> } })
      .sidePanel;
    if (!sp) return false;
    if (tabId !== undefined) await sp.open({ tabId });
    else {
      const win = await browser.windows.getCurrent();
      await sp.open({ windowId: win.id! });
    }
    setPanelPending(false);
    return true;
  } catch (err) {
    console.info('[selection-ai] panel needs a click to open', err);
    setPanelPending(true);
    return false;
  }
}

async function openPanelForArm(tabId: number | undefined): Promise<void> {
  panelOpenedForArm = await openPanel(tabId);
}

/**
 * The bar's X closes everything. Chrome 141+ has sidePanel.close(); before
 * that (and in any browser still catching up) the panel document closes its
 * own window when asked, so it is asked either way.
 */
function closePanel(windowId: number | undefined): void {
  panelOpenedForArm = false;
  const sp = (browser as unknown as { sidePanel?: { close?(o: { windowId: number }): Promise<void> } }).sidePanel;
  if (sp?.close && windowId !== undefined) void sp.close({ windowId }).catch(() => {});
  void browser.runtime.sendMessage({ type: 'panel:close', windowId }).catch(() => {});
  if (import.meta.env.FIREFOX) {
    void (browser as unknown as { sidebarAction?: { close(): Promise<void> } }).sidebarAction?.close().catch(() => {});
  }
}

/** Asks the page to offer a "Show it" button, since we cannot open the panel ourselves. */
async function promptForPanel(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    if (isOwnPage(tabId)) await browser.runtime.sendMessage({ type: 'panel:needs-click', tabId });
    else await browser.tabs.sendMessage(tabId, { type: 'panel:needs-click' });
  } catch {
    // Nothing listening; the toolbar badge is the remaining signal.
  }
}

/** A badge on the toolbar is the only hint we can give without a gesture. */
function setPanelPending(value: boolean): void {
  panelPending = value;
  void browser.action.setBadgeText({ text: value ? '1' : '' }).catch(() => {});
  if (value) void browser.action.setBadgeBackgroundColor({ color: '#2563eb' }).catch(() => {});
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const pong = await browser.tabs.sendMessage(tabId, { type: 'ping' });
    if (pong === 'pong') return;
  } catch {
    /* not injected yet */
  }
  await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
}

/**
 * Tabs showing our own reader page. They run the selection flow themselves, so
 * they must not be injected into. tabs.get only reveals a URL with the "tabs"
 * permission, which we do not ask for, so the reader announces itself instead.
 */
const readerTabs = new Set<number>();

function isOwnPage(tabId: number | undefined): boolean {
  return tabId !== undefined && readerTabs.has(tabId);
}

async function startSelection(tabId: number | undefined, kind: SelectionKind): Promise<void> {
  if (tabId === undefined) return;
  const current = await getSettings();
  const tab = await browser.tabs.get(tabId);
  const host = safeHost(tab.url);
  if (host && current.blockedSites.includes(host)) {
    console.info('[selection-ai] blocked site, ignoring', host);
    return;
  }

  if (isOwnPage(tabId)) {
    // Chrome refuses to inject a content script into an extension page, and
    // tabs.sendMessage does not reach one either, so broadcast with the tab id.
    await browser.runtime.sendMessage({ type: 'selection:start', kind, tabId }).catch(() => {});
    armedTabId = tabId;
    return;
  }

  try {
    await ensureContentScript(tabId);
  } catch (err) {
    console.warn('[selection-ai] cannot inject into this page', err);
    return;
  }
  const msg: StartSelectionMsg = { type: 'selection:start', kind };
  await browser.tabs.sendMessage(tabId, msg);
  armedTabId = tabId;
}

function safeHost(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

async function handleSelectionDone(msg: SelectionDoneMsg, tab: chrome.tabs.Tab | undefined): Promise<void> {
  const tabId = tab?.id;
  const windowId = tab?.windowId;
  if (tabId === undefined || windowId === undefined) return;
  const current = await getSettings();

  let capture: CaptureResult | undefined;
  let notice: string | undefined;
  if (msg.kind !== 'text') {
    try {
      capture = await captureWithRetry(windowId, msg);
    } catch (err) {
      console.warn('[selection-ai] capture failed', err);
      // A box is only its screenshot now, so without one there is nothing
      // to send. Say so, rather than quietly asking about nothing.
      notice = "Couldn't take a screenshot of that area. Select it again; if it keeps failing, reload the page.";
    }
  }
  const plan = buildPlan({ selection: msg, mode: 'ask', capture });
  // The selection joins the window's chat, whatever page it came from; an
  // answer still streaming there carries on. Whether a panel is open is read
  // now, not when the write gets its turn: a panel whose hello lands in
  // between must still take this selection's chat over.
  const panelOpen = panelOpenIn(windowId);
  let added: Awaited<ReturnType<typeof addSelection>>;
  try {
    added = await serial(() => addSelection(windowId, { panelOpen, plan, notice, tabId }));
  } catch (err) {
    console.warn('[selection-ai] could not keep the selection', err);
    return;
  }
  const { chat, dropped } = added;
  await noteDropped(dropped);

  if (panelPending) await promptForPanel(tabId);
  const usable = !notice && plan.parts.length > 0;
  // Auto-send waits its turn: an answer already streaming is not cut off.
  if (usable && shouldAutoSend(current, msg.kind) && !streams.has(chat.id)) void sendChat(chat.id, fallbackQuestion(current));
}

/**
 * Chrome allows two captureVisibleTab calls a second. A student reselecting
 * quickly can hit that, so one refusal gets a single, slightly later retry.
 */
async function captureWithRetry(windowId: number | undefined, msg: SelectionDoneMsg): Promise<CaptureResult> {
  try {
    return await captureRect(windowId, msg.rect, msg.devicePixelRatio, msg.path);
  } catch (err) {
    if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(String((err as Error)?.message ?? err))) throw err;
    await new Promise((r) => setTimeout(r, 600));
    return await captureRect(windowId, msg.rect, msg.devicePixelRatio, msg.path);
  }
}

/**
 * The newest selection in the chats open right now — from one tab when a tab
 * is given — with its screenshots filled back in. For tests and diagnostics.
 */
async function planFor(tabId: number | undefined) {
  const chats = await Promise.all((await allCurrent()).map(([, c]) => getChat(c.chatId)));
  const newest = chats
    .flatMap((c) => c?.items ?? [])
    .filter((i): i is SelectionItem => i.kind === 'selection' && (tabId === undefined || i.tabId === tabId))
    .sort((a, b) => b.at - a.at)[0];
  return newest ? await hydratePlan(newest.plan) : null;
}

async function withPixels(a: Attachment): Promise<Attachment> {
  return { ...a, parts: await hydrateParts(a.parts) };
}

/**
 * Asks a question in a chat. It carries every selection made since the last
 * answered question (select, select, ask sends both); earlier questions go
 * along as history, each with the selections it carried. The answer streams
 * into the chat, so it survives the panel closing and shows in the menu.
 */
async function sendChat(chatId: string, question: string): Promise<void> {
  if (streams.has(chatId)) return; // one answer at a time; the panel shows Stop meanwhile
  const controller = new AbortController();
  streams.set(chatId, controller);

  let answerId = '';
  let text = '';
  const finish = (done: Partial<AssistantItem>, opts = { touch: false, index: false }) =>
    serial(() =>
      updateChat(
        chatId,
        (c) => ({ ...c, items: c.items.map((i) => (i.id === answerId && i.kind === 'assistant' ? { ...i, text, ...done } : i)) }),
        opts,
      ),
    );

  try {
    const setup = await serial(async () => {
      const chat = await getChat(chatId);
      if (!chat || !hasUsableSelection(chat)) return null;
      const settled: Chat = { ...chat, items: chat.items.map(settle) };
      const pending = pendingSelections(settled);
      const q = question.trim() || fallbackQuestion(settings);
      const user: UserItem = { kind: 'user', id: crypto.randomUUID(), at: Date.now(), text: q, selections: pending.map((s) => s.id) };
      const answer: AssistantItem = { kind: 'assistant', id: crypto.randomUUID(), at: Date.now(), text: '', streaming: true };
      const saved = await saveChat({ ...settled, items: [...settled.items, user, answer] });
      await noteDropped(saved.dropped);
      return { chat: settled, pending, q, answerId: answer.id };
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
    const [current, keys] = await Promise.all([getSettings(), getKeys()]);
    try {
      const ctx: ProviderContext = {
        fetch: globalThis.fetch.bind(globalThis),
        keys,
        settings: { ...current, gatewayUrl: GATEWAY_URL },
        cache: new AreaCacheStore(browser.storage.local),
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
          Object.assign(done, { usage: chunk.usage, model: chunk.model, cached: chunk.cached });
          void recordStatus(current, { ok: true });
        } else if (chunk.code === 'aborted') {
          // A stop keeps whatever arrived; only an empty stop needs saying.
          if (!text.trim()) done.error = 'Stopped before an answer arrived.';
        } else {
          done.error = chunk.message;
          done.errorCode = chunk.code;
          void recordStatus(current, { ok: false, code: chunk.code, message: chunk.message });
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
    if (streams.get(chatId) === controller) streams.delete(chatId);
  }
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

/**
 * Try again after a failed answer: the failed question and its error are
 * dropped and the question is asked afresh — with the same selections, since
 * they were never answered.
 */
async function retryChat(chatId: string): Promise<void> {
  if (streams.has(chatId)) return;
  const question = await serial(async () => {
    const chat = await getChat(chatId);
    const answer = chat?.items.at(-1);
    const asked = chat?.items.at(-2);
    if (!chat || answer?.kind !== 'assistant' || !answer.error || asked?.kind !== 'user') return null;
    await saveChat({ ...chat, items: chat.items.slice(0, -2) }, { touch: false });
    return asked.text;
  });
  if (question !== null) await sendChat(chatId, question);
}

/** A selection taken back before any question carried it. */
async function dropSelection(chatId: string, itemId: string): Promise<void> {
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
let checking: { key: string; run: Promise<AiStatus> } | null = null;
async function aiStatus(force: boolean): Promise<AiStatus> {
  const [current, keys] = await Promise.all([getSettings(), getKeys()]);
  const choice = answerChoiceOf(current);
  // In memory only; the key is part of it so a fixed key is checked afresh.
  const key = `${choice}|${current.localBaseUrl}|${current.provider === 'byok' ? keys[current.vendor] : ''}`;
  if (checking?.key === key) return await checking.run;
  const stored = (await browser.storage.session.get(STATUS_KEY))[STATUS_KEY] as AiStatus | undefined;
  if (!force && stored && stored.choice === choice && Date.now() - stored.checkedAt < STATUS_TTL_MS) return stored;

  const before = checking?.run ?? Promise.resolve();
  const run = before
    .catch(() => undefined)
    .then(async () => {
      let status: AiStatus;
      try {
        status = await checkStatus(globalThis.fetch.bind(globalThis), current, keys);
      } catch (err) {
        status = { state: 'error', choice, who: '', message: (err as Error).message, checkedAt: Date.now() };
      }
      await browser.storage.session.set({ [STATUS_KEY]: status });
      return status;
    });
  checking = { key, run };
  const done = () => {
    if (checking?.run === run) checking = null;
  };
  run.then(done, done);
  return await run;
}

/** What an answer proved about the connection, if anything. */
async function recordStatus(current: Settings, outcome: Parameters<typeof statusFromAnswer>[1]): Promise<void> {
  const status = statusFromAnswer(current, outcome);
  if (status) await browser.storage.session.set({ [STATUS_KEY]: status });
}
