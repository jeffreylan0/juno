/**
 * Typed messages between the content script, the background, the reader and
 * the panel. Every message carries a `type`. The content script and the
 * reader send theirs through `send()` below, which survives the extension
 * being reloaded under the page.
 *
 * Chats do not travel over messages at all: the background writes them to
 * storage (chats.ts) and the panel renders from storage change events.
 * Messages here are commands only. The panel also holds a port open to the
 * background (PanelPortMsg), which is how the background knows a panel is
 * open and when it closes.
 */
import type { Point, Rect, SelectionKind } from '@shared/payload';

/**
 * Content → background, the instant a selection is committed and before any
 * capture work. Chrome opens the side panel from a content-script gesture only
 * while that activation is live, so this is the one chance to catch it.
 */
export interface SelectionCommittedMsg {
  type: 'selection:committed';
  kind: SelectionKind;
}

/**
 * Content → background: the user finished a selection. The reply comes as
 * soon as the screenshot is taken, so the page can change again.
 */
export interface SelectionDoneMsg {
  type: 'selection:done';
  kind: SelectionKind;
  rect: Rect;
  devicePixelRatio: number;
  /** The selected text (text selections only; boxes and elements send pixels). */
  text?: string;
  html?: string;
  /** Element selections: what was picked, in words. */
  label?: string;
  /** Element selections: part of it was off screen and could not be captured. */
  clipped?: boolean;
  /**
   * Freeform selections: the outline, in viewport CSS pixels. Text read off
   * the screen (the app): the highlight's outline, for its picture.
   */
  path?: Point[];
  /**
   * Text the app read off the screen rather than a page's own characters;
   * `unsure`: the picture should go along with it (screen-text.ts, needsPicture).
   */
  read?: { unsure: boolean };
  /** The viewport the rect is in, CSS pixels (the app crops a whole display with it). */
  viewport?: { width: number; height: number };
  page: { url: string; title: string };
}

/**
 * Content → background: Escape stopped the selection being made. The reply
 * says whether that also hides the bar ({ end: true }: nothing had been
 * selected in this chat yet, so Escape meant "never mind").
 */
export interface SelectionCancelMsg {
  type: 'selection:cancel';
}

/**
 * Content/reader → background: ✕ on the bar, or Escape while it waits. Hides
 * the bar and the panel and finishes the chat; it stays in the menu.
 */
export interface ChatFinishMsg {
  type: 'chat:finish';
}

/**
 * Background → content/reader. `bar:show` brings the bar up selecting in
 * `mode` (the icon was clicked); `bar:hide` takes it away (the student
 * switched tabs, or the chat was finished from the panel); `bar:ghost` says
 * whether the next selection goes into a temporary chat. The reader only
 * answers messages with its `tabId`.
 */
export type BarControlMsg = (
  /** `arm: false`: the bar comes up with nothing armed (the app, before it may see the screen). */
  | { type: 'bar:show'; mode: SelectionKind; ghost: boolean; arm?: boolean }
  | { type: 'bar:hide' }
  | { type: 'bar:ghost'; on: boolean }
) & { tabId?: number };

/**
 * Anything → background: the newest selection in any open chat (or from one
 * tab), with its screenshots filled back in. Tests and diagnostics use it.
 */
export interface PlanGetMsg {
  type: 'plan:get';
  tabId?: number;
}

/** Panel → background: ask a question in a chat. It carries every selection not yet asked about. */
export interface ChatSendMsg {
  type: 'chat:send';
  chatId: string;
  question: string;
}

/** Panel → background: ask the last failed question again. */
export interface ChatRetryMsg {
  type: 'chat:retry';
  chatId: string;
}

/** Panel → background: stop the answer streaming in a chat. */
export interface ChatStopMsg {
  type: 'chat:stop';
  chatId: string;
}

/**
 * Panel or bar → background: the ghost. On: the next selection goes into a
 * temporary chat. Off: leave the temporary chat (it is deleted). The bar
 * leaves out `windowId`; its tab says which window. Replies with the Current.
 */
export interface ChatTemporaryMsg {
  type: 'chat:temporary';
  windowId?: number;
  on: boolean;
}

/** Panel → background: show a chat from the menu in this window. */
export interface ChatOpenMsg {
  type: 'chat:open';
  windowId: number;
  chatId: string;
}

export interface ChatRenameMsg {
  type: 'chat:rename';
  chatId: string;
  title: string;
}

export interface ChatDeleteMsg {
  type: 'chat:delete';
  chatId: string;
}

/** Options → background: delete every saved chat and its screenshots. */
export interface ChatsDeleteAllMsg {
  type: 'chats:delete-all';
}

/** Panel → background: take back a selection no question has carried yet. */
export interface ChatDropSelectionMsg {
  type: 'chat:drop-selection';
  chatId: string;
  itemId: string;
}

/** Panel → background: check (or re-check) that the chosen AI is reachable. Replies with an AiStatus. */
export interface AiCheckMsg {
  type: 'ai:check';
  force?: boolean;
}

/**
 * Options → background: check an API key by listing the vendor's models. It
 * costs nothing, proves the key works, and returns the models to pick from.
 */
export interface KeysTestMsg {
  type: 'keys:test';
  vendor: 'anthropic' | 'openai';
  key: string;
}

/** Content (the tooltip's Show it) → background: open the answer panel from a real user gesture. */
export interface PanelOpenMsg {
  type: 'panel:open';
}

/**
 * Background → panel: close yourself. For browsers without sidePanel.close()
 * (Chrome before 141), a side panel document may close its own window.
 */
export interface PanelCloseMsg {
  type: 'panel:close';
  windowId?: number;
}

/**
 * Background → panel: a selection was just made and is on its way (the
 * screenshot and crop take a moment). The panel shows a placeholder for it,
 * so it never opens on nothing.
 */
export interface SelectionIncomingMsg {
  type: 'selection:incoming';
  kind: SelectionKind;
  /** When it was made (Date.now()): a selection in the chat from then on is it. */
  at: number;
  windowId?: number;
}

/** The port a panel keeps open to the background, named this. */
export const PANEL_PORT = 'panel';

/**
 * Panel → background over the port. `hello` says which window the panel is
 * in; after the worker restarts, the panel says hello again and `claim`s the
 * chat it is showing. `ping` keeps the worker awake while a panel is open, so
 * that closing the panel is always noticed.
 */
export type PanelPortMsg =
  | { type: 'hello'; windowId: number; claim?: { chatId: string; temporary: boolean } }
  | { type: 'ping' };

/**
 * Reader → background on load. Registers the tab as one that runs the
 * selection flow itself, and the reply tells the reader its own tab id — an
 * extension page cannot learn either without the "tabs" permission.
 */
export interface ReaderHelloMsg {
  type: 'reader:hello';
}

/** Background → content/reader: offer a click that can open the answer panel. */
export interface PanelNeedsClickMsg {
  type: 'panel:needs-click';
  tabId?: number;
}

/** Notice popup → background: the student is pinning the icon; confirm when it is done. */
export interface PinWatchMsg {
  type: 'pin:watch';
}

/** Copy chats to and from the cloud now (a panel or the settings page opened). */
export interface SyncNowMsg {
  type: 'sync:now';
}

/** Delete the signed-in account and its cloud copies; chats here stay. Replies { ok } or { error }. */
export interface AccountDeleteMsg {
  type: 'account:delete';
}

/** Content/reader → background: open the full settings page. */
export interface OptionsOpenMsg {
  type: 'options:open';
}

export type RuntimeMessage =
  | SelectionCommittedMsg
  | SelectionDoneMsg
  | SelectionCancelMsg
  | ChatFinishMsg
  | BarControlMsg
  | PlanGetMsg
  | ChatSendMsg
  | ChatStopMsg
  | ChatRetryMsg
  | ChatTemporaryMsg
  | ChatOpenMsg
  | ChatRenameMsg
  | ChatDeleteMsg
  | ChatsDeleteAllMsg
  | ChatDropSelectionMsg
  | AiCheckMsg
  | KeysTestMsg
  | PanelOpenMsg
  | PanelCloseMsg
  | SelectionIncomingMsg
  | PanelNeedsClickMsg
  | OptionsOpenMsg
  | PinWatchMsg
  | SyncNowMsg
  | AccountDeleteMsg
  | ReaderHelloMsg;

export function isRuntimeMessage(x: unknown): x is RuntimeMessage {
  return !!x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string';
}

/**
 * Whether this script's extension is still there. After the extension is
 * updated, reloaded or removed, a content script left on a page is orphaned:
 * `runtime.id` goes away and every extension call throws.
 */
export function extensionAlive(): boolean {
  try {
    return !!browser.runtime?.id;
  } catch {
    return false;
  }
}

/**
 * runtime.sendMessage that never throws and never rejects: null when nobody
 * answered or the extension is gone. An orphaned script's sendMessage throws
 * "Extension context invalidated" synchronously, which a `.catch()` on its
 * result never sees — hence the try around the call itself.
 */
export async function send<T = unknown>(msg: RuntimeMessage | { type: string; [k: string]: unknown }): Promise<T | null> {
  if (!extensionAlive()) return null;
  try {
    return ((await browser.runtime.sendMessage(msg)) as T | undefined) ?? null;
  } catch {
    return null;
  }
}
