/**
 * Background (MV3 service worker on Chrome/Edge, background script on Firefox).
 * Arms selections, captures the tab, runs the planner, and owns every chat.
 * Anything that holds keys or makes network calls lives here, never in the
 * content script.
 *
 * Clicking the toolbar action brings up the selection bar on that tab, armed
 * in the last mode used. The answer panel opens with the first selection, so
 * it never covers the page while the student is still choosing what to
 * select, and stays open from tab to tab. Switching to another tab takes the
 * bar away; the icon brings it back wherever the student is.
 *
 * Chats (lib/chats.ts) collect selections from any page in the window. ✕ on
 * the bar or the panel (or Escape on a waiting bar) hides both and finishes
 * the chat (lib/current.ts has the rules). This file is the only writer, and
 * it writes one change at a time (`serial`), so a selection landing while an
 * answer streams is never overwritten by the stream's next write.
 */
import type { AskRequest, Attachment, ChatTurn, SelectionKind } from '@shared/payload';
import { deleteAccount } from '@/lib/account/cloud';
import { currentSession, sessionItem } from '@/lib/account/session';
import { ChatSync } from '@/lib/account/sync';
import { captureVisible, cropDataUrl, type CaptureResult } from '@/lib/capture';
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
} from '@/lib/chats';
import {
  addSelection,
  allCurrent,
  discardOrphans,
  endChat,
  ensureCurrent,
  getBarTab,
  getCurrent,
  onTemporaryDiscarded,
  panelOpened,
  replaceGone,
  setBarTab,
  setTemporary,
  switchTo,
  type Current,
} from '@/lib/current';
import { deletePartImages, hydrateParts, hydratePlan } from '@/lib/images';
import {
  PANEL_PORT,
  isRuntimeMessage,
  type BarControlMsg,
  type PanelPortMsg,
  type RuntimeMessage,
  type SelectionDoneMsg,
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
  type Keys,
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

/** The chat limit dropped a chat: tell the panels, once. */
async function noteDropped(dropped: ChatSummary[]): Promise<void> {
  if (!dropped.length) return;
  for (const c of dropped) stopStream(c.id);
  await browser.storage.session.set({ lastDropped: { titles: dropped.map((c) => c.title || 'Untitled chat'), at: Date.now() } });
}

/**
 * Settings, cached. The toolbar click has to call sidePanel.open() before any
 * await or Chrome drops the gesture, so "is this a blocked site?" is first
 * answered from here — and checked again against stored settings before the
 * bar goes on the page, since a worker just woken has not read them yet.
 */
let settings: Settings = DEFAULT_SETTINGS;
/**
 * Whether the student let the extension onto file:// pages (Chrome's own
 * switch), cached for the same reason; null until checked, when the bar is
 * simply tried.
 */
let fileAccess: boolean | null = null;

/** Cloud copies of saved chats, for accounts that have them (account/sync.ts). */
let sync: ChatSync | null = null;

/** The keys an answer or a check needs; for hosted answers, the account's current token. */
async function keysFor(current: Settings): Promise<Keys> {
  const keys = await getKeys();
  if (current.provider !== 'gateway') return { ...keys, session: '' };
  return { ...keys, session: (await currentSession())?.accessToken ?? '' };
}

export default defineBackground(() => {
  // Inside main, not at module level: WXT evaluates entrypoint modules in Node
  // at build time, where there is no browser to read from.
  void getSettings().then((s) => (settings = s));
  void checkFileAccess();
  settingsItem.watch(() =>
    void getSettings().then((s) => {
      const before = `${answerChoiceOf(settings)} ${settings.localBaseUrl}`;
      settings = s;
      // Picking another model: check the new choice right away.
      if (panels.size && before !== `${answerChoiceOf(s)} ${s.localBaseUrl}`) void aiStatus(true);
      // Keeping fewer chats (the settings page asked first): the oldest go
      // now. Checked on every change, since a worker that was asleep cannot
      // tell a lowered limit from the one it just read.
      void serial(async () => {
        const dropped = await pruneChats();
        await replaceGone(dropped.map((c) => c.id));
        await noteDropped(dropped);
      });
    }),
  );
  keysItem.watch(() => void (panels.size && aiStatus(true)));
  // Signing in or out changes whether hosted answers can be asked.
  sessionItem.watch((now, before) => {
    if (now?.user.id !== before?.user.id && settings.provider === 'gateway' && panels.size) void aiStatus(true);
  });

  // A temporary chat's answer is not worth finishing (or paying for) once the
  // chat is gone, however it went: ✕ on the bar, the ghost, another chat opened.
  onTemporaryDiscarded(stopStream);
  void restoreReaderTabs();
  void serial(settleStreaming);
  sync = new ChatSync({
    serial,
    gone: async (ids) => {
      ids.forEach(stopStream);
      await serial(() => replaceGone(ids));
    },
  }).start();
  // Answers used to be kept by request hash so a rerun was free; they are no
  // longer, so none outlives its chat. Clear what earlier versions stored.
  browser.runtime.onInstalled.addListener(({ reason }) => {
    void clearAnswerCache();
    if (reason === 'install') void promptToPin();
  });
  // A temporary chat left behind, screenshots nobody points at: tidied once,
  // after any panel that is still open has had a moment to reconnect.
  setTimeout(() => {
    void serial(async () => {
      await discardOrphans();
      await sweepImages((await allCurrent()).map(([, c]) => c.chatId));
    });
  }, 3_000);

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT) return;
    let windowId: number | undefined;
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as PanelPortMsg;
      if (msg?.type !== 'hello' || windowId !== undefined) return; // pings only keep us awake
      windowId = msg.windowId;
      const open = panels.get(windowId) ?? new Set();
      open.add(port);
      panels.set(windowId, open);
      setPanelPending(false);
      void serial(() => panelOpened(msg.windowId, msg.claim)).then(
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
      // ✕ on the side panel: the bar goes too, and the chat is finished.
      void finishChat(windowId);
    });
  });

  browser.action.onClicked.addListener((tab) => {
    // The click grants this tab, so its URL is known right here — in time to
    // open the panel on the click's own gesture when the bar cannot go on
    // this page, so the student sees why instead of nothing.
    const why = tab?.url ? unreachable(tab.url, settings) : null;
    if (why) {
      // The tooltip, from the icon itself: the page cannot have it.
      showNotice(why);
      // Turned on since the worker started? The next click will know.
      if (why === 'file-access') void checkFileAccess();
      return;
    }
    if (import.meta.env.FIREFOX) void openPanel(tab?.id);
    void lastKindItem.getValue().then((kind) => summon(tab, kind));
  });

  // The main shortcut is bound to _execute_action, which arrives as
  // action.onClicked above. These are the optional per-mode shortcuts.
  browser.commands.onCommand.addListener((command, tab) => {
    const kind = COMMAND_KINDS[command];
    if (!kind) return;
    if (import.meta.env.FIREFOX) void openPanel(tab?.id);
    void summon(tab, kind);
  });

  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (!isRuntimeMessage(raw)) return;
    const msg: RuntimeMessage = raw;
    switch (msg.type) {
      case 'selection:committed':
        // First statement, before any await: this is the drag's (or the
        // confirm click's) user activation, and Chrome only honours
        // sidePanel.open() while it is live. Opening an open panel changes
        // nothing; closed by hand, it comes back with the next selection.
        // (Firefox opened its sidebar on the icon click instead: it counts
        // only the browser's own UI as a gesture.)
        if (!import.meta.env.FIREFOX) void openPanel(sender.tab?.id);
        return;
      case 'selection:done':
        // Answered as soon as the screenshot is taken: the bar waits for
        // that, and the rest (cropping, saving, asking) carries on here.
        return reply(handleSelectionDone(msg, sender.tab), sendResponse);
      case 'selection:cancel': {
        const w = sender.tab?.windowId;
        if (w === undefined) return;
        return reply(cancelSelection(w), sendResponse);
      }
      case 'chat:finish':
        if (sender.tab?.windowId !== undefined) return reply(finishChat(sender.tab.windowId), sendResponse);
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
      case 'chat:temporary': {
        // From the panel (which names its window) or the bar (whose tab does).
        const w = msg.windowId ?? sender.tab?.windowId;
        if (w === undefined) return;
        return reply(
          serial(() => setTemporary(w, msg.on)).then((current) => {
            void tellGhost(w, current.temporary);
            return current;
          }),
          sendResponse,
        );
      }
      case 'chat:open':
        return reply(
          serial(() => switchTo(msg.windowId, msg.chatId)).then((current) => {
            void tellGhost(msg.windowId, current.temporary);
            return current;
          }),
          sendResponse,
        );
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
            await sync?.deleteAll();
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
        // Sent from a click on the page's tooltip, which carries a real gesture.
        void openPanel(sender.tab?.id);
        return;
      case 'options:open':
        void browser.runtime.openOptionsPage();
        return;
      case 'pin:watch':
        void watchForPin();
        return;
      case 'sync:now':
        sync?.soon(0);
        return;
      case 'account:delete':
        void (async () => {
          const s = await currentSession();
          if (!s) return { error: 'Signed out already.' };
          await deleteAccount(s.user.id);
          await sync?.reset();
          return { ok: true };
        })()
          .catch((err: Error) => ({ error: err.message }))
          .then(sendResponse);
        return true;
      case 'reader:hello':
        // The reader cannot know its own tab id without the tabs permission,
        // and we cannot recognise it by URL for the same reason. One hello
        // settles both: we remember the tab, it learns its id from the reply.
        if (sender.tab?.id !== undefined) {
          readerTabs.add(sender.tab.id);
          void saveReaderTabs();
          sendResponse({ tabId: sender.tab.id });
        }
        return true;
      default:
        return;
    }
  });

  // Switching tabs takes the bar off the one it was on. Nothing is kept for
  // coming back: the icon brings it up wherever the student is.
  // Switching, while the student is using it (the panel is open), to a page
  // it cannot select on says so at once.
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    void (async () => {
      const on = await getBarTab(windowId);
      if (on !== undefined && on !== tabId) {
        await setBarTab(windowId, null);
        await tellBar(on, { type: 'bar:hide' });
      }
      if (!panels.has(windowId) || noticed.has(tabId)) return;
      const why = await unreachableTab(tabId);
      if (why) {
        noticed.add(tabId);
        showNotice(why);
      }
    })();
  });

  // A window closing takes everything in it along.
  browser.windows.onRemoved.addListener((windowId) => {
    void serial(() => endChat(windowId)).catch(() => {});
  });
});

/** Sends a message to the bar's surface on a tab — the reader or a web page; resolves with its answer. */
async function tellBar(tabId: number, msg: BarControlMsg): Promise<unknown> {
  const send = isOwnPage(tabId) ? browser.runtime.sendMessage({ ...msg, tabId }) : browser.tabs.sendMessage(tabId, msg);
  return await Promise.race([send, new Promise((r) => setTimeout(() => r(undefined), 800))]).catch(() => undefined);
}

/** The ghost changed (on the bar, the panel, or by opening a saved chat): the bar shows it. */
async function tellGhost(windowId: number, on: boolean): Promise<void> {
  const tabId = await getBarTab(windowId);
  if (tabId !== undefined) await tellBar(tabId, { type: 'bar:ghost', on });
}

/**
 * ✕ on the bar or on the side panel (or Escape on a waiting bar): both are
 * hidden and the chat is finished — kept in the menu, or deleted if temporary.
 */
async function finishChat(windowId: number): Promise<void> {
  const tabId = await getBarTab(windowId);
  await serial(() => endChat(windowId));
  if (tabId !== undefined) await tellBar(tabId, { type: 'bar:hide' });
  closePanel(windowId);
}

/**
 * Escape stopped a selection. With nothing selected in this chat yet it meant
 * "never mind", so the bar (and the panel) go; otherwise the bar waits.
 */
async function cancelSelection(windowId: number): Promise<{ end: boolean }> {
  const current = await getCurrent(windowId);
  const chat = current ? await getChat(current.chatId) : null;
  if (chat?.items.length) return { end: false };
  await finishChat(windowId);
  return { end: true };
}

/** The icon or a shortcut: the bar comes up on this tab, selecting in `kind`. */
async function summon(tab: chrome.tabs.Tab | undefined, kind: SelectionKind): Promise<void> {
  if (tab?.id === undefined) return;
  const tabId = tab.id;
  const known = tab.windowId !== undefined && tab.url ? tab : await browser.tabs.get(tabId).catch(() => undefined);
  const windowId = known?.windowId;
  if (windowId === undefined) return;
  const url = known?.url;
  if (known) noteReader({ ...tab, url });
  // Against the stored settings, not the cache: a worker woken by this very
  // click has not read them yet, and a blocked site must never get the bar.
  const why = url ? unreachable(url, await getSettings()) : null;
  if (why) {
    showNotice(why);
    return;
  }
  if (!isOwnPage(tabId)) {
    try {
      await ensureContentScript(tabId);
    } catch (err) {
      console.info('[selection-ai] the bar cannot go on this page', err);
      showNotice(url?.startsWith('file:') && !import.meta.env.FIREFOX ? 'file-access' : 'restricted');
      if (url?.startsWith('file:')) void checkFileAccess();
      return;
    }
  }
  // The student may have moved on while the script went in.
  if ((await browser.tabs.get(tabId).catch(() => undefined))?.active === false) return;
  const ghost = !!(await getCurrent(windowId))?.temporary;
  const before = await getBarTab(windowId);
  await setBarTab(windowId, tabId);
  if (before !== undefined && before !== tabId) void tellBar(before, { type: 'bar:hide' });
  await tellBar(tabId, { type: 'bar:show', mode: kind, ghost });
}

/** Why the bar cannot go on a page (see unreachable()). */
type Unreachable = 'restricted' | 'blocked-site' | 'file-access';

/**
 * The yellow tooltip, in a popup under the toolbar icon (entrypoints/notice):
 * for pages the extension cannot or must not touch, and the pin prompt.
 * Called synchronously, so a click's gesture carries through (Firefox wants
 * one); Chrome opens it without. The popup clears itself again on load, so
 * the next click on the icon brings up the bar as usual.
 */
function showNotice(kind: Unreachable | 'pin' | 'pinned'): void {
  const action = browser.action as unknown as {
    setPopup(o: { popup: string }): Promise<void>;
    openPopup?(): Promise<void>;
  };
  if (typeof action.openPopup !== 'function') return;
  void action.setPopup({ popup: `notice.html?kind=${kind}` }).catch(() => {});
  void action
    .openPopup()
    .catch((err: unknown) => console.info('[selection-ai] could not show the tooltip', err))
    .finally(() => void action.setPopup({ popup: '' }).catch(() => {}));
}

/** Tabs already told they cannot be selected on, so switching back does not say it again. */
const noticed = new Set<number>();

/**
 * Whether the tab just switched to is one the bar cannot go on. Its address is
 * known only where the icon was clicked before; elsewhere Chrome says, when
 * asked to run nothing there, whether it could ever run — except that the new
 * tab page cannot be told apart from other browser pages, and a tooltip there
 * would take the focus from the address bar, so those are left alone.
 */
async function unreachableTab(tabId: number): Promise<Unreachable | null> {
  if (isOwnPage(tabId)) return null;
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  if (!tab) return null;
  if (tab.url) return NEW_TAB.test(tab.url) ? null : unreachable(tab.url, await getSettings());
  try {
    await browser.scripting.executeScript({ target: { tabId }, func: () => 0 });
    return null;
  } catch (err) {
    return /extensions gallery cannot be scripted/i.test(String((err as Error)?.message ?? err)) ? 'restricted' : null;
  }
}

const NEW_TAB = /^(chrome|edge|brave|vivaldi):\/\/(newtab|new-tab-page)|^chrome-search:|^about:(newtab|home|blank)/;

/**
 * Once, on install: the icon is how the bar is brought up, so it should be on
 * the toolbar. Chrome lets only the student pin it, so the tooltip shows how
 * and says so once it is done.
 */
async function promptToPin(): Promise<void> {
  if (await isPinned()) return;
  showNotice('pin');
}

async function isPinned(): Promise<boolean | null> {
  const action = browser.action as unknown as { getUserSettings?(): Promise<{ isOnToolbar?: boolean }> };
  if (typeof action.getUserSettings !== 'function') return null; // Firefox: on the toolbar from the start
  return !!(await action.getUserSettings().catch(() => ({ isOnToolbar: true }))).isOnToolbar;
}

/** After "Show me how": waits (up to two minutes) for the pin, then confirms from the icon itself. */
let watchingPin = false;
async function watchForPin(): Promise<void> {
  if (watchingPin) return;
  watchingPin = true;
  try {
    for (let i = 0; i < 120; i++) {
      if (await isPinned()) {
        showNotice('pinned');
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    watchingPin = false;
  }
}

/**
 * Why the bar cannot go on a page, or null if it can: the browser's own pages
 * and the extension stores take no content script; a blocked site is the
 * student's choice; local files need Chrome's "Allow access to file URLs".
 */
function unreachable(url: string, s: Pick<Settings, 'blockedSites'>): Unreachable | null {
  if (url.startsWith(browser.runtime.getURL('/reader.html'))) return null;
  // Not known yet (a worker just woken): let the injection try, and say so only if it fails.
  if (url.startsWith('file:')) return fileAccess !== false ? null : import.meta.env.FIREFOX ? 'restricted' : 'file-access';
  if (!/^https?:/.test(url)) return 'restricted';
  const host = safeHost(url);
  if (host && STORE_HOSTS.some((h) => host === h || url.startsWith(`https://${h}/`))) return 'restricted';
  return host && s.blockedSites.includes(host) ? 'blocked-site' : null;
}

/** Extension galleries, where browsers let no extension run. */
const STORE_HOSTS = ['chromewebstore.google.com', 'chrome.google.com/webstore', 'microsoftedge.microsoft.com', 'addons.mozilla.org'];

async function checkFileAccess(): Promise<void> {
  try {
    fileAccess = !!(await (browser.extension as unknown as { isAllowedFileSchemeAccess(): Promise<boolean> }).isAllowedFileSchemeAccess());
  } catch {
    fileAccess = false;
  }
}

/** Keeps the reader registry right: the click tells us what the tab shows now. */
function noteReader(tab: chrome.tabs.Tab): void {
  if (tab.id === undefined || !tab.url) return;
  const reader = tab.url.startsWith(browser.runtime.getURL('/reader.html'));
  if (reader === readerTabs.has(tab.id)) return;
  if (reader) readerTabs.add(tab.id);
  else readerTabs.delete(tab.id);
  void saveReaderTabs();
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

/**
 * The bar's X closes everything. Chrome 141+ has sidePanel.close(); before
 * that (and in any browser still catching up) the panel document closes its
 * own window when asked, so it is asked either way.
 */
function closePanel(windowId: number | undefined): void {
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
    /* not injected yet, or injected by a copy of the extension that was since reloaded */
  }
  await browser.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
}

/**
 * Tabs showing our own reader page. They run the selection flow themselves, so
 * they must not be injected into. tabs.get only reveals a URL with the "tabs"
 * permission, which we do not ask for, so the reader announces itself; a click
 * on the icon (which does reveal the URL) corrects the list if the tab has
 * moved on since.
 */
const readerTabs = new Set<number>();
const READER_TABS_KEY = 'readerTabs';
/** Kept in storage.session too: a reader says hello once, and the worker may restart long after. */
function saveReaderTabs(): Promise<void> {
  return browser.storage.session.set({ [READER_TABS_KEY]: [...readerTabs] });
}
async function restoreReaderTabs(): Promise<void> {
  const saved = (await browser.storage.session.get(READER_TABS_KEY))[READER_TABS_KEY] as number[] | undefined;
  for (const id of saved ?? []) readerTabs.add(id);
}

function isOwnPage(tabId: number | undefined): boolean {
  return tabId !== undefined && readerTabs.has(tabId);
}

function safeHost(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

/**
 * A selection arrived. Resolves once the tab has been captured, so the page
 * (and the bar on it) can change again; cropping, saving and any auto-ask
 * carry on after that.
 */
async function handleSelectionDone(msg: SelectionDoneMsg, tab: chrome.tabs.Tab | undefined): Promise<void> {
  const tabId = tab?.id;
  const windowId = tab?.windowId;
  if (tabId === undefined || windowId === undefined) return;
  // The chat it was made for, fixed now: whatever the student does while it
  // is cropped and saved (the ghost, ✕, another chat) cannot move it.
  const into = serial(() => ensureCurrent(windowId));
  // captureVisibleTab takes whichever tab the window shows; if that is no
  // longer this one, the screenshot would be of another page.
  const shown = msg.kind === 'text' || (await browser.tabs.get(tabId).catch(() => undefined))?.active !== false;
  if (!shown) return;
  const shot = msg.kind === 'text' ? Promise.resolve(null) : captureWithRetry(windowId);
  void keepSelection(msg, tabId, windowId, shot, into);
  await shot.catch(() => undefined);
}

async function keepSelection(
  msg: SelectionDoneMsg,
  tabId: number,
  windowId: number,
  shot: Promise<string | null>,
  into: Promise<Current>,
): Promise<void> {
  const current = await getSettings();
  let capture: CaptureResult | undefined;
  let notice: string | undefined;
  try {
    const full = await shot;
    if (full) capture = await cropDataUrl(full, msg.rect, msg.devicePixelRatio, msg.path);
  } catch (err) {
    console.warn('[selection-ai] capture failed', err);
    // A box is only its screenshot now, so without one there is nothing
    // to send. Say so, rather than quietly asking about nothing.
    notice = "Couldn't take a screenshot of that. Try again, or reload the page.";
  }
  const plan = buildPlan({ selection: msg, mode: 'ask', capture });
  // The selection joins the chat it was made for, whatever page it came
  // from; an answer still streaming there carries on.
  let added: Awaited<ReturnType<typeof addSelection>>;
  try {
    const target = await into;
    added = await serial(() => addSelection(windowId, { plan, notice, tabId, into: target }));
  } catch (err) {
    console.warn('[selection-ai] could not keep the selection', err);
    return;
  }
  if (!added) return; // its chat was finished or deleted meanwhile
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
async function captureWithRetry(windowId: number): Promise<string> {
  try {
    return await captureVisible(windowId);
  } catch (err) {
    if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota/i.test(String((err as Error)?.message ?? err))) throw err;
    await new Promise((r) => setTimeout(r, 600));
    return await captureVisible(windowId);
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
      await replaceGone(saved.dropped.map((c) => c.id));
      await noteDropped(saved.dropped);
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
    const keys = await keysFor(current);
    try {
      const ctx: ProviderContext = {
        fetch: globalThis.fetch.bind(globalThis),
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
  const current = await getSettings();
  const keys = await keysFor(current);
  const choice = answerChoiceOf(current);
  // In memory only; the key is part of it so a fixed key (or a new sign-in) is checked afresh.
  const key = `${choice}|${current.localBaseUrl}|${current.provider === 'byok' ? keys[current.vendor] : current.provider === 'gateway' ? keys.session.slice(-16) : ''}`;
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

/** Answers earlier versions kept by request hash (`cache:<hash>`), removed on install and update. */
async function clearAnswerCache(): Promise<void> {
  const stale = Object.keys(await browser.storage.local.get(null)).filter((k) => k.startsWith('cache:'));
  if (stale.length) await browser.storage.local.remove(stale);
}

/** What an answer proved about the connection, if anything. */
async function recordStatus(current: Settings, outcome: Parameters<typeof statusFromAnswer>[1]): Promise<void> {
  const status = statusFromAnswer(current, outcome);
  if (status) await browser.storage.session.set({ [STATUS_KEY]: status });
}
