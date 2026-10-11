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
 * the chat (lib/current.ts has the rules). The background is the only writer,
 * and it writes one change at a time (`serial`), so a selection landing while
 * an answer streams is never overwritten by the stream's next write. That
 * half — the queue, answering, the cloud copy, the connection status — is
 * lib/engine.ts, which the desktop app's core window runs too; this file is
 * the browser half: tabs, the toolbar icon, the side panel, captureVisibleTab.
 */
import type { SelectionKind } from '@shared/payload';
import { deleteAccount } from '@/lib/account/cloud';
import { currentSession } from '@/lib/account/session';
import { captureVisible, cropDataUrl } from '@/lib/capture';
import { deleteAllChats, deleteChat, getChat, listChats, renameChat } from '@/lib/chats';
import {
  endChat,
  ensureCurrent,
  getBarTab,
  getCurrent,
  panelOpened,
  replaceGone,
  setBarTab,
  setTemporary,
  switchTo,
  type Current,
} from '@/lib/current';
import { ChatEngine } from '@/lib/engine';
import {
  PANEL_PORT,
  isRuntimeMessage,
  type BarControlMsg,
  type PanelPortMsg,
  type RuntimeMessage,
  type SelectionDoneMsg,
} from '@/lib/messages';
import { testKey } from '@/lib/providers/byok';
import { getSettings, lastKindItem, type Settings } from '@/lib/storage';

const CONTENT_SCRIPT = 'content-scripts/content.js';

const COMMAND_KINDS: Record<string, SelectionKind> = {
  'select-box': 'box',
  'select-text': 'text',
  'select-element': 'element',
  'select-freeform': 'freeform',
};
/** True when a plan is waiting and the panel could not be opened for it. */
let panelPending = false;

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

/**
 * Chats, answers, the cloud copy and the connection status (lib/engine.ts,
 * shared with the desktop app). Its settings cache is what the toolbar click
 * reads: it has to call sidePanel.open() before any await or Chrome drops the
 * gesture, so "is this a blocked site?" is first answered from there — and
 * checked again against stored settings before the bar goes on the page,
 * since a worker just woken has not read them yet.
 */
const engine = new ChatEngine({ fetch: (input, init) => globalThis.fetch(input, init), panelsOpen: () => panels.size > 0 });
const serial = <T>(task: () => Promise<T>) => engine.serial(task);

/**
 * Whether the student let the extension onto file:// pages (Chrome's own
 * switch), cached for the same reason; null until checked, when the bar is
 * simply tried.
 */
let fileAccess: boolean | null = null;

export default defineBackground(() => {
  // Inside main, not at module level: WXT evaluates entrypoint modules in Node
  // at build time, where there is no browser to read from.
  engine.start();
  void checkFileAccess();
  void restoreReaderTabs();
  // Answers used to be kept by request hash so a rerun was free; they are no
  // longer, so none outlives its chat. Clear what earlier versions stored.
  browser.runtime.onInstalled.addListener(({ reason }) => {
    void clearAnswerCache();
    if (reason === 'install') void promptToPin();
  });

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
    const why = tab?.url ? unreachable(tab.url, engine.settings) : null;
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
        // A placeholder in the panel until the selection itself arrives.
        void browser.runtime
          .sendMessage({ type: 'selection:incoming', kind: msg.kind, at: Date.now(), windowId: sender.tab?.windowId })
          .catch(() => {});
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
        void engine.planFor(msg.tabId).then(sendResponse);
        return true;
      case 'chat:send':
        void engine.sendChat(msg.chatId, msg.question);
        return;
      case 'chat:retry':
        void engine.retryChat(msg.chatId);
        return;
      case 'chat:stop':
        engine.abortStream(msg.chatId);
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
        engine.stopStream(msg.chatId);
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
            ids.forEach((id) => engine.stopStream(id));
            await deleteAllChats();
            await engine.sync?.deleteAll();
            await replaceGone(ids);
          }),
          sendResponse,
        );
      case 'chat:drop-selection':
        return reply(serial(() => engine.dropSelection(msg.chatId, msg.itemId)), sendResponse);
      case 'ai:check':
        return reply(engine.aiStatus(!!msg.force), sendResponse);
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
        engine.sync?.soon(0);
        return;
      case 'account:delete':
        void (async () => {
          const s = await currentSession();
          if (!s) return { error: 'Signed out already.' };
          await deleteAccount(s.user.id);
          await engine.sync?.reset();
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
  await engine.keepSelection(
    {
      selection: msg,
      windowId,
      tabId,
      into,
      capture: async () => {
        const full = await shot;
        return full ? await cropDataUrl(full, msg.rect, msg.devicePixelRatio, msg.path) : undefined;
      },
    },
    async () => {
      if (panelPending) await promptForPanel(tabId);
    },
  );
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

/** Answers earlier versions kept by request hash (`cache:<hash>`), removed on install and update. */
async function clearAnswerCache(): Promise<void> {
  const stale = Object.keys(await browser.storage.local.get(null)).filter((k) => k.startsWith('cache:'));
  if (stale.length) await browser.storage.local.remove(stale);
}
