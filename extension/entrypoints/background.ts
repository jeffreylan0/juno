/**
 * Background (MV3 service worker on Chrome/Edge, background script on Firefox).
 * Arms selections, captures the tab, runs the planner and router, and streams
 * tokens to the panel over a Port. Anything that holds keys or makes network
 * calls lives here, never in the content script.
 *
 * The toolbar action opens the popup (manifest `default_popup`), so there is no
 * onClicked listener; the popup arms the selection, and the answer panel opens
 * only once a selection has actually been made.
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

export default defineBackground(() => {
  browser.commands.onCommand.addListener((command, tab) => {
    const kind: SelectionKind | null = command === 'select-box' ? 'box' : command === 'select-text' ? 'text' : null;
    if (kind) void startSelection(tab?.id, kind);
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
          void browser.tabs.sendMessage(armedTabId, { type: 'selection:abort' }).catch(() => {});
          armedTabId = undefined;
        }
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
      default:
        return;
    }
  });

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

async function startSelection(tabId: number | undefined, kind: SelectionKind): Promise<void> {
  if (tabId === undefined) return;
  const settings = await getSettings();
  const tab = await browser.tabs.get(tabId);
  const host = safeHost(tab.url);
  if (host && settings.blockedSites.includes(host)) {
    console.info('[selection-ai] blocked site, ignoring', host);
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

  // The panel appears now, not when the toolbar icon was clicked.
  await openPanel(planTabId);
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
