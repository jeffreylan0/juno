/**
 * The app's hidden core window. The chat half is lib/engine.ts (the write
 * queue, answers, the cloud copy, the connection status); this file shows
 * the bar and the panel and keeps the chat in step with them:
 *
 *  - the first time the app is opened, the first-run setup comes up instead
 *    (settings/Setup.tsx), and the bar once it is done;
 *  - the shortcut (or the menu bar icon, or opening the app) brings the bar
 *    up, armed in Box, on the display under the pointer;
 *    while macOS has not let the app see the screen, the bar comes up with
 *    a note asking for it instead (overlay/notices.ts);
 *  - a selection is committed: the panel shows (it is made at start and
 *    kept, so nothing waits for it to load), with a placeholder for the
 *    selection until it arrives;
 *  - the selection is done: the native core captures that display without
 *    the app's own windows and crops it; the selection joins the chat;
 *  - while a selection is drawn, the bar and the panel step aside;
 *  - ✕ or Escape (on the bar or the panel) hides both and finishes the
 *    chat, by lib/current.ts's rules;
 *  - the bar's chats button opens the panel on its list of chats; while the
 *    panel shows, the bar leaves the ghost, settings and chats to it;
 *  - the panel's new-chat key (⌘⇧O, Ctrl+Shift+O) finishes the chat and
 *    brings the bar up for the next.
 *
 * There is one panel, so one "window" of chats (WINDOW_ID). The window a
 * selection was made over comes from the native core, at capture time.
 */
import { browser, note, transport } from '../platform/install';
import { WINDOW_ID, type Port } from '../platform/browser';
import { appFetch } from '../platform/net';
import { nativeVault, watchKeys } from '../platform/vault';
import { endChat, ensureCurrent, panelOpened, setTemporary, startsTemporary, switchTo } from '@/lib/current';
import { ChatEngine, reply, type KeptCapture } from '@/lib/engine';
import { extrasOpenNow, withinPlan } from '@/lib/extras';
import { getSettings, panelSizeItem } from '@/lib/storage';
import { PANEL_PORT, isRuntimeMessage, type BarControlMsg, type PanelPortMsg, type RuntimeMessage, type SelectionDoneMsg } from '@/lib/messages';
import type { NoticeReply } from '../overlay/notices';
import { pageTitle, type OverlayNotice } from './tips';

const W = WINDOW_ID;

/** The panel's ports (it has one, kept from the start; a reload in development briefly makes two). */
const panels = new Set<Port>();
/** Whether the panel is on screen: it is kept, hidden, between chats (wm.rs). */
let panelShown = false;
/** The panel is shown, but out of sight while a selection is drawn (drawing()). */
let panelAside = false;
const engine = new ChatEngine({ fetch: appFetch, vault: nativeVault, watchKeys, panelsOpen: () => panelShown }).start();
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

async function tellOverlay(
  msg: BarControlMsg | { type: 'overlay:notice'; notice: OverlayNotice | null } | { type: 'overlay:panel'; open: boolean },
): Promise<void> {
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
 * Box, whatever was used last time. On macOS, until the app may record the
 * screen, it comes up with nothing armed and a note asking for that instead.
 */
async function summon(): Promise<void> {
  const blocked = (await transport.invoke<string>('screen_access')) === 'denied' && !screenLater;
  const mode = 'box';
  const ghost = await startsTemporary(W);
  // Focused, so Escape (and Enter on a drawn box) reach it while selecting.
  await transport.invoke('overlay_show', { focus: true }).catch((err) => note(`overlay_show failed: ${String(err)}`));
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

/**
 * ✕ or Escape, on the bar or the panel: both go, then the chat is
 * finished. In that order: finished first, the panel
 * would show its empty new chat for a moment on its way out.
 */
async function finishChat(): Promise<void> {
  if (barUp) {
    barUp = false;
    void tellOverlay({ type: 'bar:hide' });
  }
  await closePanel();
  await serial(() => endChat(W));
}

/**
 * The panel goes at once. (Its content fading out would leave the empty
 * window, which the system draws, on screen for a moment: a flash.)
 */
async function closePanel(): Promise<void> {
  panelAside = false;
  if (!panelShown) return;
  panelShown = false;
  void tellOverlay({ type: 'overlay:panel', open: false });
  await transport.invoke('panel_close').catch(() => {});
}

/**
 * While a selection is being drawn, the panel steps aside (the bar does too,
 * on its own page) and comes back once the drawing ends, without taking the
 * keyboard from the overlay; a selection made opens it as usual.
 */
async function drawing(on: boolean): Promise<void> {
  if (on) {
    if (!panelShown || panelAside) return;
    panelAside = true;
    await transport.invoke('panel_close', { aside: true }).catch(() => {});
    return;
  }
  if (!panelAside) return;
  panelAside = false;
  const [place, size] = await Promise.all([panelPlace(), panelSizeItem.getValue().catch(() => null)]);
  // Closed meanwhile (Escape while drawing), or opened by the selection made.
  if (!panelShown || panelAside) return;
  await transport.invoke('panel_open', { focus: false, place, size }).catch(() => {});
}

async function tellGhost(on: boolean): Promise<void> {
  if (barUp) await tellOverlay({ type: 'bar:ghost', on });
}

/**
 * Shows the panel, playing its entrance if it was hidden: where the student
 * put it (the setting), as big as they last made it, if they did.
 */
async function openPanel(): Promise<void> {
  panelAside = false;
  if (!panelShown) {
    await browser.tell('panel', { type: 'card:enter' }).catch(() => {});
    void tellOverlay({ type: 'overlay:panel', open: true });
  }
  panelShown = true;
  const [place, size] = await Promise.all([panelPlace(), panelSizeItem.getValue().catch(() => null)]);
  await transport
    .invoke('panel_open', { focus: true, place, size })
    .catch((err) => note(`panel_open failed: ${String(err)}`));
}

/** Where the panel goes: the setting, while the extras are open (lib/extras.ts). */
async function panelPlace(): Promise<string> {
  const [settings, open] = await Promise.all([getSettings(), extrasOpenNow()]);
  return withinPlan(settings, open).panelPlace;
}

/** The panel's new-chat key: this chat is finished, the panel shows the new one, and the bar comes up for its first selection. */
async function newChat(): Promise<void> {
  await serial(() => endChat(W));
  await summon();
}

/** The bar's chats button: the panel, open on its list of chats. */
async function openChats(): Promise<void> {
  await browser.tell('panel', { type: 'panel:chats' }).catch(() => {});
  await openPanel();
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
  const shot = transport.invoke<Captured>('capture_selection', {
    request: { rect: msg.rect, path: msg.path ?? null, viewport: msg.viewport ?? { width: 0, height: 0 } },
  });
  void engine.keepSelection({
    selection: msg,
    windowId: W,
    into,
    capture: async (): Promise<KeptCapture | undefined> => {
      try {
        const c = await shot;
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
              ? "Couldn't see the screen: Screen Recording is off for Juno. Turn it on in System Settings, then restart the app."
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
    if (msg?.type !== 'hello' || hello) return;
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

browser.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!isRuntimeMessage(raw)) return;
  const msg = raw as RuntimeMessage | NoticeReply | { type: 'overlay:ready' | 'chats:open' | 'chat:new' | 'setup:done' };
  if (isRuntimeMessage(msg) && engine.handles(msg)) return engine.handle(msg, sendResponse);
  switch (msg.type) {
    case 'overlay:ready':
      overlayLoaded();
      overlayReady = Promise.resolve();
      return;
    case 'screen:enable':
      void enableScreen();
      return;
    case 'chats:open':
      void openChats();
      return;
    case 'chat:new':
      void newChat();
      return;
    case 'setup:done':
      void summon();
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
    case 'selection:drawing':
      void drawing(msg.on);
      return;
    case 'chat:finish':
      return reply(finishChat(), sendResponse);
    case 'options:open':
      void transport.invoke('settings_open', { hash: null });
      return;
    case 'app:escape':
      // Escape, in the panel or settings: everything goes. The chat is finished only if it showed.
      return reply(
        (async () => {
          if (barUp || panelShown) await finishChat();
          await transport.invoke('window_close').catch(() => {});
        })(),
        sendResponse,
      );
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
    default:
      return;
  }
});

// ── The native core ──────────────────────────────────────────────────────

void transport.listen('app:summon', () => void summon());
// Settings are on screen (wm::show_window; from the bar's gear or the menu
// bar icon): the bar goes, and the dim with it. The chat carries on; the
// shortcut brings the bar back.
void transport.listen('app:settings', () => {
  if (!barUp) return;
  barUp = false;
  void tellOverlay({ type: 'bar:hide' });
});
void browser.ready.then(() => browser.tell('overlay', { type: 'overlay:ping' }));

// Opening the app brings the bar up, as the shortcut does (unless it was
// started out of sight, with --hidden); the first time, the setup instead.
// Another app holding the shortcut is said once, on the bar.
void transport
  .invoke<{ hidden: boolean; shortcut: { error: string | null } }>('app_info')
  .then(async (info) => {
    shortcutUntold = !!info.shortcut.error;
    note(info.hidden ? 'ready (hidden)' : 'ready');
    if (info.hidden) return;
    if ((await getSettings()).setupDone) await summon();
    else await transport.invoke('settings_open', { hash: null });
  })
  .catch((err) => note(`start failed: ${String(err)}`));
