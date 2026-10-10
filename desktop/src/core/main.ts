/**
 * The app's hidden core window: what the extension's background is, for the
 * desktop. The chat half is the same code (lib/engine.ts: the write queue,
 * answers, the cloud copy, the connection status); this file is the
 * desktop half, in place of tabs, the toolbar icon and the side panel:
 *
 *  - the shortcut (or the menu bar icon) brings the bar up, armed in the
 *    last mode used, on the display under the pointer;
 *  - a selection is committed: the panel opens, docked right;
 *  - the selection is done: the native core captures that display without
 *    the app's own windows and crops it; the selection joins the chat;
 *  - ✕ on the bar or the panel (or Escape before anything was selected)
 *    hides both and finishes the chat, by lib/current.ts's rules.
 *
 * There is one panel, so one "window" of chats (WINDOW_ID). Where the
 * extension knows a tab, the app knows the window a selection was made over,
 * from the native core, at capture time.
 */
import { browser, transport } from '../platform/install';
import { WINDOW_ID, type Port } from '../platform/browser';
import { appFetch } from '../platform/net';
import { deleteAccount } from '@/lib/account/cloud';
import { currentSession } from '@/lib/account/session';
import { deleteAllChats, deleteChat, getChat, listChats, renameChat } from '@/lib/chats';
import { endChat, ensureCurrent, getCurrent, panelOpened, replaceGone, setTemporary, switchTo } from '@/lib/current';
import { ChatEngine, type KeptCapture } from '@/lib/engine';
import { PANEL_PORT, isRuntimeMessage, type BarControlMsg, type PanelPortMsg, type RuntimeMessage, type SelectionDoneMsg } from '@/lib/messages';
import { testKey } from '@/lib/providers/byok';
import { lastKindItem } from '@/lib/storage';
import { pageTitle, type OverlayTip } from './tips';

const W = WINDOW_ID;

/** Open panels (the app has one; a reload in development briefly makes two). */
const panels = new Set<Port>();
const engine = new ChatEngine({ fetch: appFetch, panelsOpen: () => panels.size > 0 }).start();
const serial = <T>(task: () => Promise<T>) => engine.serial(task);

/** Whether the bar is up. */
let barUp = false;

// ── The overlay window ───────────────────────────────────────────────────

/**
 * The overlay page says when it is listening; messages wait for that. It
 * says so when it loads, and again when asked (below), since the two pages
 * load side by side and its first word can come before the core listens.
 */
let overlayLoaded: () => void = () => {};
let overlayReady = new Promise<void>((r) => (overlayLoaded = r));

async function tellOverlay(msg: BarControlMsg | { type: 'overlay:tip'; tip: OverlayTip }): Promise<void> {
  await Promise.race([overlayReady, new Promise((r) => setTimeout(r, 4000))]);
  await browser.tell('overlay', msg);
}

/** The yellow tooltip, at the top of the display under the pointer. */
async function tip(which: OverlayTip): Promise<void> {
  if (!barUp) await transport.invoke('overlay_show', { focus: false });
  await tellOverlay({ type: 'overlay:tip', tip: which });
}

// ── The bar ──────────────────────────────────────────────────────────────

/** The shortcut or the menu: the bar comes up selecting in the last mode used. */
async function summon(): Promise<void> {
  // macOS: nothing can be selected until the app may record the screen. The
  // first time, this shows the system's own prompt; after that, the tooltip
  // says where the switch is.
  if ((await transport.invoke<string>('screen_access')) === 'denied') {
    await transport.invoke('screen_access_request');
    await tip('screen-permission');
    return;
  }
  const mode = await lastKindItem.getValue();
  const ghost = !!(await getCurrent(W))?.temporary;
  // Focused, so Escape (and Enter on an adjusted box) reach it while selecting.
  await transport.invoke('overlay_show', { focus: true });
  barUp = true;
  await tellOverlay({ type: 'bar:show', mode, ghost });
}

/** ✕ on the bar or the panel (or Escape before anything was selected): both go, the chat is finished. */
async function finishChat(): Promise<void> {
  await serial(() => endChat(W));
  if (barUp) {
    barUp = false;
    await tellOverlay({ type: 'bar:hide' });
  }
  await transport.invoke('panel_close').catch(() => {});
}

/** Escape stopped a selection: with nothing selected in this chat yet it meant "never mind". */
async function cancelSelection(): Promise<{ end: boolean }> {
  const current = await getCurrent(W);
  const chat = current ? await getChat(current.chatId) : null;
  if (chat?.items.length) return { end: false };
  await finishChat();
  return { end: true };
}

async function tellGhost(on: boolean): Promise<void> {
  if (barUp) await tellOverlay({ type: 'bar:ghost', on });
}

async function openPanel(): Promise<void> {
  await transport.invoke('panel_open', { focus: true }).catch((err) => console.warn('[selection-ai] panel', err));
}

// ── A selection ──────────────────────────────────────────────────────────

interface Captured {
  dataUrl: string;
  width: number;
  height: number;
  source: { app: string; title: string } | null;
}

/** What the native core says when it could not capture. */
interface CaptureFailure {
  code: 'permission' | 'failed';
  message: string;
}

/**
 * Answered as soon as the screen is captured and cropped, so the bar can wait
 * for the next selection; saving and any auto-ask carry on after that.
 */
async function handleSelectionDone(msg: SelectionDoneMsg): Promise<void> {
  // The chat it was made for, fixed now (current.ts).
  const into = serial(() => ensureCurrent(W));
  const shot: Promise<Captured | undefined> =
    msg.kind === 'text'
      ? Promise.resolve(undefined)
      : transport.invoke<Captured>('capture_selection', {
          request: { rect: msg.rect, path: msg.path ?? null, viewport: msg.viewport ?? { width: 0, height: 0 } },
        });
  void engine.keepSelection({
    selection: msg,
    windowId: W,
    into,
    capture: async (): Promise<KeptCapture | undefined> => {
      try {
        const c = await shot;
        if (!c) return undefined;
        // The window it was made over names it; the overlay's own page never does.
        return { dataUrl: c.dataUrl, width: c.width, height: c.height, page: { url: '', title: c.source ? pageTitle(c.source) : '' } };
      } catch (raw) {
        const failure = raw as Partial<CaptureFailure>;
        if (failure?.code === 'permission') void tip('screen-permission');
        throw Object.assign(new Error(failure?.message ?? String(raw)), {
          notice:
            failure?.code === 'permission'
              ? "Couldn't see the screen: Screen Recording is off for Selection AI. Turn it on in System Settings, then restart the app."
              : "Couldn't take a screenshot of that. Try again.",
        });
      }
    },
  });
  await shot.catch(() => undefined);
}

// ── The panel's port: open while the panel is ───────────────────────────

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT) return;
  let hello = false;
  port.onMessage.addListener((raw) => {
    const msg = raw as PanelPortMsg;
    if (msg?.type !== 'hello' || hello) return; // pings only
    hello = true;
    panels.add(port);
    void serial(() => panelOpened(W, msg.claim)).then(
      () => port.postMessage({ type: 'ready' }),
      () => port.postMessage({ type: 'ready' }),
    );
  });
  port.onDisconnect.addListener(() => {
    if (!panels.delete(port) || panels.size) return;
    // The panel was closed: the bar goes too, and the chat is finished.
    void finishChat();
  });
});

// ── Messages from the overlay, the panel and settings ───────────────────

/** Replies once the work is done, whether it worked or not (as the background's reply()). */
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

browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!isRuntimeMessage(raw) && (raw as { type?: string })?.type !== 'overlay:ready') return;
  const msg = raw as RuntimeMessage | { type: 'overlay:ready' };
  switch (msg.type) {
    case 'overlay:ready':
      overlayLoaded();
      overlayReady = Promise.resolve();
      return;
    case 'selection:committed':
      void openPanel();
      return;
    case 'selection:done':
      return reply(handleSelectionDone(msg), sendResponse);
    case 'selection:cancel':
      return reply(cancelSelection(), sendResponse);
    case 'chat:finish':
      return reply(finishChat(), sendResponse);
    case 'panel:open':
      void openPanel();
      return;
    case 'options:open':
      void transport.invoke('settings_open', { hash: null });
      return;
    case 'plan:get':
      void engine.planFor(undefined).then(sendResponse);
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
    case 'chat:temporary':
      return reply(
        serial(() => setTemporary(W, msg.on)).then((current) => {
          void tellGhost(current.temporary);
          return current;
        }),
        sendResponse,
      );
    case 'chat:open':
      return reply(
        serial(() => switchTo(W, msg.chatId)).then((current) => {
          void tellGhost(current.temporary);
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
      void testKey(appFetch, msg.vendor, msg.key).then(sendResponse);
      return true;
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
    default:
      return;
  }
});

// ── The native core ──────────────────────────────────────────────────────

void transport.listen('app:summon', () => void summon());
void browser.ready.then(() => browser.tell('overlay', { type: 'overlay:ping' }));

// Another app holds the shortcut: say so once, at start.
void transport
  .invoke<{ shortcut: { error: string | null } }>('app_info')
  .then((info) => info.shortcut.error && setTimeout(() => void tip('shortcut-taken'), 1500))
  .catch(() => {});

void browser.ready.then(() => console.info('[selection-ai] core ready'));
