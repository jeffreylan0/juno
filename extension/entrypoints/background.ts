/**
 * Background (MV3 service worker on Chrome/Edge, background script on Firefox).
 * Arms selections, captures the tab, runs the planner, and owns every tab's
 * conversation. Anything that holds keys or makes network calls lives here,
 * never in the content script.
 *
 * Clicking the toolbar action arms a selection immediately. By default the
 * answer panel opens once a selection is made, so it never covers the page
 * while the student is still choosing what to select; a setting opens it on
 * the click instead.
 *
 * Each tab has its own thread in storage.session (lib/threads.ts). This file
 * is the only writer: it appends the student's turn, streams the answer into
 * the thread, and the panel renders whatever is stored for the tab it shows.
 */
import type { AskRequest, SelectionKind } from '@shared/payload';
import { AreaCacheStore } from '@/lib/cache';
import { captureRect, type CaptureResult } from '@/lib/capture';
import { isRuntimeMessage, type RuntimeMessage, type SelectionDoneMsg, type StartSelectionMsg } from '@/lib/messages';
import { buildPlan } from '@/lib/planner';
import { callModel, type ProviderContext } from '@/lib/providers';
import { testKey } from '@/lib/providers/byok';
import {
  DEFAULT_SETTINGS,
  GATEWAY_URL,
  fallbackQuestion,
  getKeys,
  getSettings,
  lastKindItem,
  settingsItem,
  shouldAutoSend,
  type Settings,
} from '@/lib/storage';
import {
  clearThread,
  getThread,
  historyOf,
  parseKey,
  saveChat,
  startThread,
  type Chat,
  type Turn,
} from '@/lib/threads';

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
/** One in-flight answer per tab, so a second question stops the first. */
const streams = new Map<number, AbortController>();
/**
 * Streams replaced by a newer question or selection. A stopped stream saves
 * what it has; a replaced one must not, or its last write would land on top
 * of the conversation that replaced it.
 */
const superseded = new WeakSet<AbortController>();

function supersede(tabId: number): void {
  const c = streams.get(tabId);
  if (!c) return;
  superseded.add(c);
  c.abort();
  streams.delete(tabId);
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
  settingsItem.watch(() => void getSettings().then((s) => (settings = s)));

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
        void sendChat(msg.tabId, msg.question);
        return;
      case 'chat:retry':
        void retryChat(msg.tabId);
        return;
      case 'chat:stop':
        streams.get(msg.tabId)?.abort();
        return;
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
    supersede(tabId);
    void clearThread(tabId);
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
  if (tabId === undefined) return;
  const current = await getSettings();

  let capture: CaptureResult | undefined;
  let notice: string | undefined;
  if (msg.kind !== 'text') {
    try {
      capture = await captureWithRetry(tab?.windowId, msg);
    } catch (err) {
      console.warn('[selection-ai] capture failed', err);
      // A box is only its screenshot now, so without one there is nothing
      // to send. Say so, rather than quietly asking about nothing.
      notice = "Couldn't take a screenshot of that area. Select it again; if it keeps failing, reload the page.";
    }
  }
  const plan = buildPlan({ selection: msg, mode: 'ask', capture });
  // A new selection starts a new conversation; an answer still streaming for
  // the old one is dropped rather than written into the new one.
  supersede(tabId);
  await startThread(tabId, plan, notice);

  if (panelPending) await promptForPanel(tabId);
  if (!notice && plan.parts.length > 0 && shouldAutoSend(current, msg.kind)) void sendChat(tabId, fallbackQuestion(current));
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

/** The plan for a tab, or the most recently selected one when none is given. */
async function planFor(tabId: number | undefined) {
  if (tabId !== undefined) return (await getThread(tabId)).plan;
  const all = await browser.storage.session.get(null);
  const newest = Object.entries(all)
    .map(([k, v]) => ({ key: parseKey(k), chat: v as Chat }))
    .filter((e) => e.key?.kind === 'chat')
    .sort((a, b) => (b.chat.updatedAt ?? 0) - (a.chat.updatedAt ?? 0))[0];
  return newest?.key ? (await getThread(newest.key.tabId)).plan : null;
}

/**
 * Asks a question in a tab's conversation. The selection is attached once, to
 * the opening turn (see toChatMessages); follow-ups send only text and history.
 * The answer is streamed into the thread, so it survives the panel closing and
 * reappears when the student comes back to the tab.
 */
async function sendChat(tabId: number, question: string): Promise<void> {
  supersede(tabId);
  const { plan, chat } = await getThread(tabId);
  if (!plan || plan.parts.length === 0) return;

  const base: Chat =
    chat && chat.planId === plan.id
      ? { ...chat, turns: chat.turns.map(settle) }
      : { planId: plan.id, mode: plan.mode, turns: [], updatedAt: Date.now() };
  const history = historyOf(base.turns);
  const q = question.trim() || fallbackQuestion(settings);
  const user: Turn = { id: crypto.randomUUID(), role: 'user', text: q };
  const answer: Turn = { id: crypto.randomUUID(), role: 'assistant', text: '', streaming: true };
  const thread: Chat = { ...base, turns: [...base.turns, user, answer] };
  await saveChat(tabId, thread);

  const controller = new AbortController();
  streams.set(tabId, controller);
  const request: AskRequest = { plan: { ...plan, question: q }, history };

  let dirty = false;
  const flush = async () => {
    dirty = false;
    if (superseded.has(controller)) return;
    await saveChat(tabId, thread);
  };
  const timer = setInterval(() => void (dirty && flush()), STREAM_SAVE_MS);

  try {
    const [current, keys] = await Promise.all([getSettings(), getKeys()]);
    const ctx: ProviderContext = {
      fetch: globalThis.fetch.bind(globalThis),
      keys,
      settings: { ...current, gatewayUrl: GATEWAY_URL },
      cache: new AreaCacheStore(browser.storage.local),
      signal: controller.signal,
    };
    for await (const chunk of callModel(request, plan.route, ctx, {
      provider: current.provider,
      vendor: current.vendor,
      model: current.modelOverride,
    })) {
      if (chunk.type === 'delta') {
        answer.text += chunk.text;
        dirty = true;
      } else if (chunk.type === 'done') {
        answer.streaming = false;
        answer.usage = chunk.usage;
        answer.model = chunk.model;
        answer.cached = chunk.cached;
      } else {
        answer.streaming = false;
        // A stop keeps whatever arrived; only an empty stop needs saying.
        if (chunk.code === 'aborted') {
          if (!answer.text.trim()) answer.error = 'Stopped before an answer arrived.';
        } else {
          answer.error = chunk.message;
          answer.errorCode = chunk.code;
        }
      }
    }
  } catch (err) {
    answer.streaming = false;
    answer.error = (err as Error).message;
  } finally {
    clearInterval(timer);
    answer.streaming = false;
    if (streams.get(tabId) === controller) streams.delete(tabId);
    await flush();
  }
}

/**
 * A turn left streaming by an answer that was replaced mid-flight. It keeps
 * whatever text arrived, and is marked stopped so it stops showing a spinner
 * (and, if empty, drops out of the history sent to the model).
 */
function settle(turn: Turn): Turn {
  if (!turn.streaming) return turn;
  return { ...turn, streaming: false, error: turn.text.trim() ? turn.error : 'Stopped before an answer arrived.' };
}

/**
 * Try again after a failed answer: the failed question and its error are
 * dropped and the question is asked afresh, so history stays clean.
 */
async function retryChat(tabId: number): Promise<void> {
  const { plan, chat } = await getThread(tabId);
  if (!plan || !chat || chat.planId !== plan.id) return;
  const turns = chat.turns;
  const answer = turns[turns.length - 1];
  const question = turns[turns.length - 2];
  if (answer?.role !== 'assistant' || !answer.error || question?.role !== 'user') return;
  await saveChat(tabId, { ...chat, turns: turns.slice(0, -2) });
  await sendChat(tabId, question.text);
}
