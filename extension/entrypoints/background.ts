/**
 * Background (MV3 service worker on Chrome/Edge, background script on Firefox).
 * Receives selections, captures the tab, runs the planner and router, and
 * streams tokens to the panel over a Port. Anything that holds keys or makes
 * network calls lives here, never in the content script.
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

export default defineBackground(() => {
  // Toolbar click: open the panel, then start a box selection on the page.
  browser.action.onClicked.addListener((tab) => {
    void openPanel(tab);
    void startSelection(tab.id, 'box');
  });

  browser.commands.onCommand.addListener((command, tab) => {
    const kind: SelectionKind | null =
      command === 'select-box' ? 'box' : command === 'select-text' ? 'text' : null;
    if (!kind) return;
    void openPanel(tab);
    void startSelection(tab?.id, kind);
  });

  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (!isRuntimeMessage(raw)) return;
    const msg: RuntimeMessage = raw;
    switch (msg.type) {
      case 'selection:done':
        void handleSelectionDone(msg, sender.tab);
        return;
      case 'selection:cancel':
        return;
      case 'plan:get':
        sendResponse(pendingPlan);
        return;
      case 'plan:setMode':
        if (pendingPlan) pendingPlan = { ...pendingPlan, mode: msg.mode };
        sendResponse(pendingPlan);
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

async function openPanel(tab: chrome.tabs.Tab | undefined): Promise<void> {
  try {
    if (import.meta.env.FIREFOX) {
      await (browser as unknown as { sidebarAction?: { open(): Promise<void> } }).sidebarAction?.open();
      return;
    }
    if (import.meta.env.SAFARI) return; // overlay.ts renders the panel in-page
    const sp = (browser as unknown as { sidePanel?: { open(o: { tabId?: number; windowId?: number }): Promise<void> } })
      .sidePanel;
    if (!sp) return;
    if (tab?.id !== undefined) await sp.open({ tabId: tab.id });
    else if (tab?.windowId !== undefined) await sp.open({ windowId: tab.windowId });
  } catch (err) {
    console.warn('[selection-ai] could not open panel', err);
  }
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
  try {
    await browser.runtime.sendMessage({ type: 'plan:ready', plan: pendingPlan });
  } catch {
    // Panel not open yet; it will call plan:get on mount.
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
