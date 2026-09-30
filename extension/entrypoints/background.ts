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
 * Chats (lib/chats.ts) collect selections from any page in the window. The
 * selection bar and the panel are shown and hidden together: the icon brings
 * the bar up, one per window, and it follows the student from tab to tab; ✕
 * on either (or Escape on a waiting bar) hides both and finishes the chat
 * (lib/current.ts has the rules). This file is the only writer, and it
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
  allBars,
  allCurrent,
  getBar,
  getCurrent,
  discardOrphans,
  endChat,
  setBar,
  type BarBlocked,
  onTemporaryDiscarded,
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
/** The tab a selection is armed in, for an abort sent from an extension page. */
let armedTabId: number | undefined;
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

  // A temporary chat's answer is not worth finishing (or paying for) once the
  // chat is gone, however it went: ✕ on the bar, the ghost, another chat opened.
  onTemporaryDiscarded(stopStream);
  void restoreReaderTabs();
  void serial(settleStreaming);
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
    // this page (the browser's own pages, a blocked site), so the student
    // sees why instead of nothing.
    if (tab?.url && cannotHost(tab.url)) {
      void openPanel(tab.id);
      if (tab.windowId !== undefined) {
        const w = tab.windowId;
        void serial(() => setBar(w, { mode: null, blocked: /^(https?|file):/.test(tab.url!) ? 'blocked-site' : 'restricted' }));
      }
      return;
    }
    arm(tab?.id);
    void lastKindItem.getValue().then((kind) => summon(tab, kind));
  });

  // The main shortcut is bound to _execute_action, which arrives as
  // action.onClicked above. These are the optional per-mode shortcuts.
  browser.commands.onCommand.addListener((command, tab) => {
    const kind = COMMAND_KINDS[command];
    if (!kind) return;
    arm(tab?.id);
    void summon(tab, kind);
  });

  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (!isRuntimeMessage(raw)) return;
    const msg: RuntimeMessage = raw;
    switch (msg.type) {
      case 'selection:arm':
        void activeTab().then((tab) => summon(tab, msg.kind));
        return;
      case 'selection:abort':
        abortArmed();
        return;
      case 'selection:committed':
        // First statement, before any await: this is the drag's (or the
        // confirm click's) user activation, and Chrome only honours
        // sidePanel.open() while it is live. Opening an open panel changes
        // nothing; closed by hand, it comes back with the next selection.
        armedTabId = undefined;
        void openPanel(sender.tab?.id);
        if (sender.tab?.id !== undefined) committedAt.set(sender.tab.id, Date.now());
        // From here the bar is waiting, not selecting: a tab switch during the
        // capture must not bring it up armed somewhere else.
        if (sender.tab?.windowId !== undefined) {
          const w = sender.tab.windowId;
          void serial(async () => void ((await getBar(w)) && (await setBar(w, { mode: null }))));
        }
        return;
      case 'selection:done':
        armedTabId = undefined;
        // Answered once the capture is done, so the bar only comes back after
        // the screenshot has been taken without it. It comes back waiting.
        return reply(
          handleSelectionDone(msg, sender.tab).then(() => {
            const w = sender.tab?.windowId;
            if (w !== undefined) return serial(async () => void ((await getBar(w)) && (await setBar(w, { mode: null }))));
          }),
          sendResponse,
        );
      case 'selection:cancel': {
        armedTabId = undefined;
        const w = sender.tab?.windowId;
        if (w === undefined) return;
        return reply(cancelSelection(w), sendResponse);
      }
      case 'bar:state':
        // The bar says what it is doing (a chip picked, a selection started by
        // the shortcut): the next tab shows it the same way. Only the bar on
        // the active tab speaks for the window.
        if (sender.tab?.id !== undefined && sender.tab.windowId !== undefined && sender.tab.active !== false) {
          void noteBar(sender.tab.windowId, sender.tab.id, msg.mode);
        }
        return;
      case 'chat:finish':
        armedTabId = undefined;
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
          void saveReaderTabs();
          sendResponse({ tabId: sender.tab.id });
        }
        return true;
      default:
        return;
    }
  });

  // The bar follows the student: to whichever tab becomes active, and back
  // onto a tab whose page just loaded (a navigation takes the old bar with it).
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    void getBar(windowId).then((bar) => bar && placeBar(windowId, tabId));
  });
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status === 'loading' && readerTabs.delete(tabId)) void saveReaderTabs();
    if (change.status !== 'complete' || !tab.active || tab.windowId === undefined) return;
    const windowId = tab.windowId;
    void getBar(windowId).then((bar) => bar && placeBar(windowId, tabId));
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    if (readerTabs.delete(tabId)) void saveReaderTabs();
  });
  // Allowed onto every site: the bar can now follow to the tab it could not reach.
  browser.permissions.onAdded.addListener(() => {
    void allBars().then((bars) =>
      bars.forEach(async ([windowId]) => {
        const [tab] = await browser.tabs.query({ active: true, windowId });
        if (tab?.id !== undefined) await placeBar(windowId, tab.id);
      }),
    );
  });

  // A window closing takes everything in it along.
  browser.windows.onRemoved.addListener((windowId) => {
    void serial(() => endChat(windowId)).catch(() => {});
  });
});

/**
 * A fresh arming. With `panelOpen: on-click` the panel opens right here, on the
 * click's own gesture; otherwise it waits for the selection to be committed.
 */
function arm(tabId: number | undefined): void {
  if (settings.panelOpen === 'on-click') void openPanel(tabId);
}

/** Sends a message to the bar's surface on a tab — the reader or a web page; resolves with its answer. */
async function tellBar(tabId: number, msg: { type: 'bar:show' | 'bar:hide'; mode?: SelectionKind | null }): Promise<unknown> {
  const send = isOwnPage(tabId) ? browser.runtime.sendMessage({ ...msg, tabId }) : browser.tabs.sendMessage(tabId, msg);
  return await Promise.race([send, new Promise((r) => setTimeout(() => r(undefined), 800))]).catch(() => undefined);
}

/** When each window's chat was last finished, and when each tab last committed a selection. */
const finishedAt = new Map<number, number>();
const committedAt = new Map<number, number>();

/**
 * ✕ on the bar or on the side panel (or Escape on a waiting bar): both are
 * hidden and the chat is finished — kept in the menu, or deleted if temporary.
 */
async function finishChat(windowId: number): Promise<void> {
  finishedAt.set(windowId, Date.now());
  following.set(windowId, (following.get(windowId) ?? 0) + 1);
  const tabId = await serial(() => endChat(windowId));
  if (tabId !== undefined) await tellBar(tabId, { type: 'bar:hide' });
  for (const t of [...badged]) void clearFollowBadge(t);
  closePanel(windowId);
}

/**
 * Escape stopped a selection. With nothing selected in this chat yet it meant
 * "never mind", so the bar (and the panel) go; otherwise the bar waits.
 */
async function cancelSelection(windowId: number): Promise<{ end: boolean }> {
  const current = await getCurrent(windowId);
  const chat = current ? await getChat(current.chatId) : null;
  if (!chat?.items.length) {
    await finishChat(windowId);
    return { end: true };
  }
  await serial(async () => void ((await getBar(windowId)) && (await setBar(windowId, { mode: null }))));
  return { end: false };
}

/** The icon or the shortcut: the bar comes up (or re-arms) on this tab, in `kind`. */
async function summon(tab: chrome.tabs.Tab | undefined, kind: SelectionKind): Promise<void> {
  if (tab?.id === undefined) return;
  const windowId = tab.windowId ?? (await browser.tabs.get(tab.id).catch(() => undefined))?.windowId;
  if (windowId === undefined) return;
  await serial(() => setBar(windowId, { mode: kind }));
  await placeBar(windowId, tab.id);
}

/** A bar reported its state; it is the window's bar, on that tab. */
async function noteBar(windowId: number, tabId: number, mode: SelectionKind | null): Promise<void> {
  // The bar's own word beats a placement still on its way here.
  following.set(windowId, (following.get(windowId) ?? 0) + 1);
  // In the same queue, and in order with everything else this bar sent: a
  // report sent before its own ✕ is applied before the ✕, never after.
  const before = await serial(async () => {
    const bar = await getBar(windowId);
    await setBar(windowId, { mode, tabId, blocked: undefined });
    return bar;
  });
  if (before?.tabId !== undefined && before.tabId !== tabId) void tellBar(before.tabId, { type: 'bar:hide' });
  void clearFollowBadge(tabId);
  if (mode) armedTabId = tabId;
}

/** Bumped per window by every move, so a slow injection never lands on a tab the student has left. */
const following = new Map<number, number>();

/**
 * Puts the window's one bar on `tabId`, in the state it was in, and takes it
 * off the tab it was on. Where it cannot go (the browser's own pages, a
 * blocked site, a tab the extension has not been allowed onto) it stays where
 * it was, out of sight, and the panel says why; coming back finds it as it was.
 */
async function placeBar(windowId: number, tabId: number): Promise<void> {
  const move = (following.get(windowId) ?? 0) + 1;
  following.set(windowId, move);
  if (!(await getBar(windowId))) return;
  const blocked = await reach(tabId);
  const placed = await serial(async () => {
    if (following.get(windowId) !== move) return null; // moved on meanwhile
    const latest = await getBar(windowId);
    if (!latest) return null; // finished meanwhile
    await setBar(windowId, blocked ? { blocked } : { tabId, blocked: undefined });
    return blocked ? null : latest;
  });
  if (blocked === 'permission') void setFollowBadge(tabId);
  if (!placed) return;
  if (placed.tabId !== undefined && placed.tabId !== tabId) void tellBar(placed.tabId, { type: 'bar:hide' });
  if (following.get(windowId) !== move) return; // the next placement takes over from here
  void clearFollowBadge(tabId);
  await tellBar(tabId, { type: 'bar:show', mode: placed.mode });
  if (placed.mode) armedTabId = tabId;
}

/**
 * A tab the bar could not follow onto, for lack of permission: a "+" on the
 * icon there says one click brings it (the click grants the tab). The panel,
 * when open, offers to let it follow everywhere.
 */
const badged = new Set<number>();
async function setFollowBadge(tabId: number): Promise<void> {
  badged.add(tabId);
  await browser.action.setBadgeText({ tabId, text: '+' }).catch(() => {});
  await browser.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' }).catch(() => {});
  await browser.action.setTitle({ tabId, title: 'Click to bring the selection bar to this tab' }).catch(() => {});
}
async function clearFollowBadge(tabId: number): Promise<void> {
  if (!badged.delete(tabId)) return;
  await browser.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  await browser.action.setTitle({ tabId, title: '' }).catch(() => {});
}

/** Gets the content script onto a tab if it can go there; otherwise says why not. */
async function reach(tabId: number): Promise<BarBlocked | undefined> {
  if (isOwnPage(tabId)) return undefined;
  let url: string | undefined;
  try {
    url = (await browser.tabs.get(tabId)).url;
  } catch {
    return 'restricted';
  }
  // Browser pages, other extensions' pages and our own (the panel opened as a
  // tab) take no content script. An unknown URL is a page we have not been
  // allowed onto yet — unless the icon was clicked there, so try.
  if (url && !/^(https?|file):/.test(url)) return 'restricted';
  const host = safeHost(url);
  if (host && settings.blockedSites.includes(host)) return 'blocked-site';
  try {
    await ensureContentScript(tabId);
    return undefined;
  } catch (err) {
    // Chrome's wording tells a page we may not script at all (its own pages,
    // the Web Store) from one we have not been allowed onto yet.
    const lacking = /Cannot access contents of|must request permission|Missing host permission/i.test(String((err as Error)?.message ?? err));
    return lacking && !(await hasAllSites()) ? 'permission' : 'restricted';
  }
}

/** A page the bar can never go on: not a web page (and not our reader), or a blocked site. */
function cannotHost(url: string): boolean {
  if (url.startsWith(browser.runtime.getURL('/reader.html'))) return false;
  if (!/^(https?|file):/.test(url)) return true;
  const host = safeHost(url);
  return !!host && settings.blockedSites.includes(host);
}

/** Whether the student let the bar onto every site (an optional permission). */
async function hasAllSites(): Promise<boolean> {
  return await browser.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
}

function abortArmed(): void {
  if (armedTabId === undefined) return;
  const target = armedTabId;
  armedTabId = undefined;
  if (isOwnPage(target)) void browser.runtime.sendMessage({ type: 'selection:abort', tabId: target }).catch(() => {});
  else void browser.tabs.sendMessage(target, { type: 'selection:abort' }).catch(() => {});
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab as chrome.tabs.Tab | undefined;
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
  // ✕ was pressed (on this tab or another) while this screenshot was being
  // taken: the chat it belonged to is finished, so it does not start another.
  if ((finishedAt.get(windowId) ?? 0) > (committedAt.get(tabId) ?? Date.now())) return;
  // The selection joins the window's chat in progress, whatever page it came
  // from, or starts one; an answer still streaming there carries on.
  let added: Awaited<ReturnType<typeof addSelection>>;
  try {
    added = await serial(() => addSelection(windowId, { plan, notice, tabId }));
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
