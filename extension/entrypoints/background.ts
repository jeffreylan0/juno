/**
 * Background (MV3 service worker on Chrome/Edge, background script on Firefox).
 * Arms selections, captures the tab, runs the planner and router, and streams
 * tokens to the panel over a Port. Anything that holds keys or makes network
 * calls lives here, never in the content script.
 *
 * Clicking the toolbar action arms a selection immediately — no popup, so the
 * page is ready for input on the first click. Mode switching lives in the
 * overlay's hint; settings live on the options page. The answer panel opens
 * the instant a selection is committed, while the drag's gesture is still live.
 */
import type { AskRequest, Mode, Plan, SelectionKind } from '@shared/payload';
import { AreaCacheStore } from '@/lib/cache';
import { captureRect } from '@/lib/capture';
import {
  PORT_ASK,
  isAskPortIn,
  isRuntimeMessage,
  type AskPortOut,
  type RuntimeMessage,
  type SelectionDoneMsg,
  type StartSelectionMsg,
} from '@/lib/messages';
import { buildPlan } from '@/lib/planner';
import { callModel, type ProviderContext } from '@/lib/providers';
import { getKeys, getSettings } from '@/lib/storage';

const CONTENT_SCRIPT = 'content-scripts/content.js';

let pendingPlan: Plan | null = null;
/** True when a plan is waiting and the panel could not be opened for it. */
let panelPending = false;
/**
 * The tab a selection is armed in. Aborting and opening the panel target this
 * rather than "the active tab": the user can arm a selection and then switch
 * tabs, and the popup is not a tab at all.
 */
let armedTabId: number | undefined;
/** The tab the pending plan came from, so the panel opens against it. */
let planTabId: number | undefined;
/**
 * True once the panel has been opened for the current arming. Clicking the
 * toolbar icon is an extension gesture Chrome always honours, so that is where
 * the panel is opened; re-opening it later would only risk tripping the
 * fallback on a panel that is already there.
 */
let panelOpenedForArm = false;

export default defineBackground(() => {
  browser.action.onClicked.addListener((tab) => {
    // First statement, before any await: sidePanel.open() needs live user
    // activation, and an action click is the one gesture Chrome always accepts.
    // Waiting for the drag to finish, as this used to, leaves it to chance.
    void openPanelForArm(tab?.id);
    void getSettings().then((s) => startSelection(tab?.id, s.defaultSelectionKind));
  });

  browser.commands.onCommand.addListener((command, tab) => {
    const kind: SelectionKind | null = command === 'select-box' ? 'box' : command === 'select-text' ? 'text' : null;
    if (!kind) return;
    void openPanelForArm(tab?.id);
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
        if (armedTabId !== undefined) {
          const target = armedTabId;
          armedTabId = undefined;
          if (isOwnPage(target)) void browser.runtime.sendMessage({ type: 'selection:abort', tabId: target }).catch(() => {});
          else void browser.tabs.sendMessage(target, { type: 'selection:abort' }).catch(() => {});
        }
        return;
      case 'selection:committed':
        // The panel was opened when the selection was armed. Only try again if
        // that did not happen — a shortcut fired from a surface with no tab,
        // say — and do it here, before any await, while the drag's activation
        // is still the freshest thing Chrome has seen.
        armedTabId = undefined;
        planTabId = sender.tab?.id;
        if (!panelOpenedForArm) void openPanel(sender.tab?.id);
        return;
      case 'selection:done':
        armedTabId = undefined;
        void handleSelectionDone(msg, sender.tab);
        return;
      case 'selection:cancel':
        armedTabId = undefined;
        return;
      case 'plan:get':
        sendResponse(pendingPlan);
        return;
      case 'plan:setMode':
        if (pendingPlan) pendingPlan = { ...pendingPlan, mode: msg.mode };
        sendResponse(pendingPlan);
        return;
      case 'panel:open':
        // Sent from the popup, which has a real user gesture.
        void (async () => openPanel(planTabId ?? (await activeTabId())))();
        return;
      case 'panel:ready':
        setPanelPending(false);
        return;
      case 'options:open':
        // The bar's quick settings deliberately omit keys and prompts; this is
        // how the student reaches the page that has them.
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

  browser.tabs.onRemoved.addListener((tabId) => readerTabs.delete(tabId));

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_ASK) return;
    let controller: AbortController | null = null;
    port.onMessage.addListener((raw: unknown) => {
      if (!isAskPortIn(raw)) return;
      if (raw.type === 'ask:abort') {
        controller?.abort();
        return;
      }
      controller?.abort();
      controller = new AbortController();
      void streamAnswer(raw.request, controller.signal, (chunk) => {
        try {
          port.postMessage(chunk);
        } catch {
          controller?.abort();
        }
      });
    });
    port.onDisconnect.addListener(() => controller?.abort());
  });
});

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

/**
 * Opens the answer panel. Chrome and Firefox both require a user gesture here;
 * a message relayed from a content script does not always count, so a failure
 * is recorded and the popup offers a button that does carry one.
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
    // Expected when no gesture is in flight; the popup path recovers.
    console.info('[selection-ai] panel needs a click to open', err);
    setPanelPending(true);
    return false;
  }
}

/** Opens the panel for a fresh arming and remembers whether it worked. */
async function openPanelForArm(tabId: number | undefined): Promise<void> {
  panelOpenedForArm = await openPanel(tabId);
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

export function isPanelPending(): boolean {
  return panelPending;
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
 * they must not be injected into. Identifying them by tab.url is unreliable —
 * tabs.get only reveals a URL with the "tabs" permission, which we do not ask
 * for — so the reader announces itself on load instead.
 */
const readerTabs = new Set<number>();

function isOwnPage(tabId: number | undefined): boolean {
  return tabId !== undefined && readerTabs.has(tabId);
}

async function startSelection(tabId: number | undefined, kind: SelectionKind): Promise<void> {
  if (tabId === undefined) return;
  const settings = await getSettings();
  const tab = await browser.tabs.get(tabId);
  const host = safeHost(tab.url);
  if (host && settings.blockedSites.includes(host)) {
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
  const settings = await getSettings();
  const mode: Mode = pendingPlan?.mode ?? settings.defaultMode;
  let capture;
  if (msg.kind === 'box' || (msg.kind === 'element' && !msg.text)) {
    try {
      capture = await captureRect(tab?.windowId, msg.rect, msg.devicePixelRatio);
    } catch (err) {
      console.warn('[selection-ai] capture failed', err);
    }
  }
  pendingPlan = buildPlan({ selection: msg, mode, capture });
  planTabId = tab?.id;

  // selection:committed already tried to open the panel with the drag's
  // gesture. If Chrome refused it, ask the page for one click — that is a
  // fresh gesture in a page context, which it does accept.
  if (panelPending) await promptForPanel(planTabId);
  try {
    await browser.runtime.sendMessage({ type: 'plan:ready', plan: pendingPlan });
  } catch {
    // Panel not open yet; it calls plan:get on mount.
  }
}

async function streamAnswer(request: AskRequest, signal: AbortSignal, emit: (c: AskPortOut) => void): Promise<void> {
  const [settings, keys] = await Promise.all([getSettings(), getKeys()]);
  const ctx: ProviderContext = {
    fetch: globalThis.fetch.bind(globalThis),
    keys,
    settings,
    cache: new AreaCacheStore(browser.storage.local),
    signal,
  };
  for await (const chunk of callModel(request, request.plan.route, ctx, {
    provider: settings.provider,
    vendor: settings.vendor,
    model: settings.modelOverride,
  })) {
    if (signal.aborted) return;
    emit(chunk);
  }
}
