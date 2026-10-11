/**
 * The app's hidden core window: what the extension's background is, for the
 * desktop. The chat half is the same code (lib/engine.ts: the write queue,
 * answers, the cloud copy, the connection status); this file is the
 * desktop half, in place of tabs, the toolbar icon and the side panel:
 *
 *  - the shortcut (or the menu bar icon, or opening the app) brings the bar
 *    up, armed in the last mode used, on the display under the pointer;
 *    while macOS has not let the app see the screen, the bar comes up with
 *    a note asking for it instead (overlay/notices.ts);
 *  - a selection is committed: the panel shows (it is made at start and
 *    kept, so nothing waits for it to load), with a placeholder for the
 *    selection until it arrives;
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
import type { NoticeReply } from '../overlay/notices';
import { pageTitle, type OverlayNotice } from './tips';

const W = WINDOW_ID;

/** The panel's ports (it has one, kept from the start; a reload in development briefly makes two). */
const panels = new Set<Port>();
/** Whether the panel is on screen: it is kept, hidden, between chats (wm.rs). */
let panelShown = false;
/** Bumped by every show and hide of the panel, so a late hide never undoes a newer show. */
let panelTurn = 0;
const engine = new ChatEngine({ fetch: appFetch, panelsOpen: () => panelShown }).start();
const serial = <T>(task: () => Promise<T>) => engine.serial(task);

/** The panel's exit (card.ts), and a moment for the message to get there. */
const PANEL_LEAVE_MS = 190;

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

async function tellOverlay(msg: BarControlMsg | { type: 'overlay:notice'; notice: OverlayNotice | null }): Promise<void> {
  await Promise.race([overlayReady, new Promise((r) => setTimeout(r, 4000))]);
  await browser.tell('overlay', msg);
}

// ── The bar ──────────────────────────────────────────────────────────────

/** Screen Recording was asked for (System Settings opened) since the app started. */
let screenAsked = false;
/** "Not now" to Screen Recording: until a selection fails for it, the bar stops asking. */
let screenLater = false;
/** Another app holds the shortcut, and the bar has not said so yet. */
let shortcutUntold = false;

/**
 * The shortcut, the menu, or opening the app: the bar comes up selecting in
 * the last mode used. On macOS, until the app may record the screen, it
 * comes up with nothing armed and a note asking for that instead.
 */
async function summon(): Promise<void> {
  const blocked = (await transport.invoke<string>('screen_access')) === 'denied' && !screenLater;
  const mode = await lastKindItem.getValue();
  const ghost = !!(await getCurrent(W))?.temporary;
  // Focused, so Escape (and Enter on a drawn box) reach it while selecting.
  await transport.invoke('overlay_show', { focus: true });
  barUp = true;
  let notice: OverlayNotice | null = null;
  if (blocked) notice = screenAsked ? 'screen-restart' : 'screen-permission';
  else if (shortcutUntold) notice = 'shortcut-taken';
  if (notice === 'shortcut-taken') shortcutUntold = false;
  await tellOverlay({ type: 'overlay:notice', notice });
  await tellOverlay({ type: 'bar:show', mode, ghost, arm: !blocked });
}

/** The bar's "Turn on Screen Recording": the bar steps aside for the system's prompt and settings. */
async function enableScreen(): Promise<void> {
  screenAsked = true;
  await finishChat();
  // The first time, macOS shows its own prompt and lists the app in System
  // Settings; after that only the switch there will do.
  await transport.invoke('screen_access_request');
  await transport.invoke('open_privacy_settings');
}

/** The bar's "Not now": selecting goes ahead; a screenshot that fails for it brings the note back. */
async function screenNotNow(): Promise<void> {
  screenLater = true;
  await summon();
}

/** ✕ on the bar or the panel (or Escape before anything was selected): both go, the chat is finished. */
async function finishChat(): Promise<void> {
  await serial(() => endChat(W));
  if (barUp) {
    barUp = false;
    await tellOverlay({ type: 'bar:hide' });
  }
  await closePanel();
}

/** The panel plays its exit (card.ts), then is hidden, unless it was shown again meanwhile. */
async function closePanel(): Promise<void> {
  if (!panelShown) return;
  panelShown = false;
  const turn = ++panelTurn;
  await browser.tell('panel', { type: 'card:leave' }).catch(() => {});
  await new Promise((r) => setTimeout(r, PANEL_LEAVE_MS));
  if (turn === panelTurn) await transport.invoke('panel_close').catch(() => {});
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

/** Shows the panel, playing its entrance if it was hidden. */
async function openPanel(): Promise<void> {
  ++panelTurn;
  if (!panelShown) await browser.tell('panel', { type: 'card:enter' }).catch(() => {});
  panelShown = true;
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
  // Text read off the screen goes as text; its picture only when the
  // reading may not be exact (screen-text.ts, needsPicture).
  const shot: Promise<Captured | undefined> =
    msg.kind === 'text' && !msg.read?.unsure
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
        if (failure?.code === 'permission') {
          screenLater = false;
          if (barUp) void tellOverlay({ type: 'overlay:notice', notice: screenAsked ? 'screen-restart' : 'screen-permission' });
        }
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
    // The panel's page went away (it is only ever hidden, so a crash or a
    // reload): the bar goes too, and the chat is finished.
    void finishChat();
    panelShown = false;
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

const DESKTOP_MESSAGES = new Set(['overlay:ready', 'screen:enable', 'screen:later', 'screen:denied']);

browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!isRuntimeMessage(raw) && !DESKTOP_MESSAGES.has((raw as { type?: string })?.type ?? '')) return;
  const msg = raw as RuntimeMessage | NoticeReply | { type: 'overlay:ready' };
  switch (msg.type) {
    case 'overlay:ready':
      overlayLoaded();
      overlayReady = Promise.resolve();
      return;
    case 'screen:enable':
      void enableScreen();
      return;
    case 'screen:later':
      void screenNotNow();
      return;
    case 'screen:denied':
      screenLater = false;
      if (barUp) void tellOverlay({ type: 'overlay:notice', notice: screenAsked ? 'screen-restart' : 'screen-permission' });
      return;
    case 'selection:committed':
      // The panel at once, with a placeholder until the screenshot is in.
      void browser.tell('panel', { type: 'selection:incoming', kind: msg.kind, at: Date.now() }).catch(() => {});
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
// Settings opened (from the bar's gear or the menu bar icon): the bar goes,
// and the dim with it. The chat carries on; the shortcut brings the bar back.
void transport.listen('app:settings', () => {
  if (!barUp) return;
  barUp = false;
  void tellOverlay({ type: 'bar:hide' });
});
void browser.ready.then(() => browser.tell('overlay', { type: 'overlay:ping' }));

// Opening the app brings the bar up, as the shortcut does (unless it was
// started out of sight, with --hidden). Another app holding the shortcut is
// said once, on the bar.
void transport
  .invoke<{ hidden: boolean; shortcut: { error: string | null } }>('app_info')
  .then(async (info) => {
    shortcutUntold = !!info.shortcut.error;
    if (!info.hidden) await summon();
  })
  .catch((err) => console.warn('[selection-ai] start', err));

void browser.ready.then(() => console.info('[selection-ai] core ready'));
