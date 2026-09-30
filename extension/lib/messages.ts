/**
 * Typed messages between the content script, the background, the reader and
 * the panel. Every message carries a `type` and goes through `sendMessage`.
 *
 * Chats do not travel over messages at all: the background writes them to
 * storage (chats.ts) and the panel renders from storage change events.
 * Messages here are commands only. The panel also holds a port open to the
 * background (PanelPortMsg), which is how the background knows a panel is
 * open and when it closes.
 */
import type { Point, Rect, SelectionKind } from '@shared/payload';

/** Any extension page → background: inject the content script and arm a selection. */
export interface SelectionArmMsg {
  type: 'selection:arm';
  kind: SelectionKind;
}

/** Background → content: start an interactive selection. */
export interface StartSelectionMsg {
  type: 'selection:start';
  kind: SelectionKind;
}

/**
 * Content → background, the instant a selection is committed and before any
 * capture work. Chrome opens the side panel from a content-script gesture only
 * while that activation is live, so this is the one chance to catch it.
 */
export interface SelectionCommittedMsg {
  type: 'selection:committed';
  kind: SelectionKind;
}

/** Background → content: tear down an armed selection (Esc). */
export interface SelectionAbortMsg {
  type: 'selection:abort';
}

/** Content → background: the user finished a selection. */
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
  /** Freeform selections: the outline, in viewport CSS pixels. */
  path?: Point[];
  page: { url: string; title: string };
}

/** Content → background: Escape stopped the selection being made. */
export interface SelectionCancelMsg {
  type: 'selection:cancel';
}

/** Content/reader → background: a bar is now on this tab. */
export interface BarShownMsg {
  type: 'bar:shown';
}

/**
 * Content/reader → background: this tab's bar went away without finishing the
 * chat (Escape before it added anything).
 */
export interface BarGoneMsg {
  type: 'bar:gone';
}

/**
 * Content/reader → background: the bar's ✕. Finishes the window's chat: every
 * bar in the window goes and the panel closes; the chat stays in the menu.
 */
export interface ChatFinishMsg {
  type: 'chat:finish';
}

/**
 * Background → content/reader, about the bar:
 * - `bar:end`: the chat finished; take the bar down.
 * - `bar:pause`: a selection is starting on another tab; stop selecting here
 *   and wait, ready.
 * - `bar:alive`: is a bar up here? (Answers true.) Tabs navigate away
 *   without saying so.
 */
export interface BarControlMsg {
  type: 'bar:end' | 'bar:pause' | 'bar:alive';
}

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

/** Start a new chat in this window. No button sends this any more; kept for diagnostics. */
export interface ChatNewMsg {
  type: 'chat:new';
  windowId: number;
}

/** Panel → background: the ghost — start (or leave) a temporary chat. */
export interface ChatTemporaryMsg {
  type: 'chat:temporary';
  windowId: number;
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

/** Content/toast → background: open the answer panel from a real user gesture. */
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

/** Panel → background: the panel is alive, so nothing needs to prompt for it. */
export interface PanelReadyMsg {
  type: 'panel:ready';
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
}

/** Content/reader → background: open the full settings page. */
export interface OptionsOpenMsg {
  type: 'options:open';
}

export type RuntimeMessage =
  | SelectionArmMsg
  | StartSelectionMsg
  | SelectionCommittedMsg
  | SelectionAbortMsg
  | SelectionDoneMsg
  | SelectionCancelMsg
  | BarShownMsg
  | BarGoneMsg
  | ChatFinishMsg
  | BarControlMsg
  | PlanGetMsg
  | ChatSendMsg
  | ChatStopMsg
  | ChatRetryMsg
  | ChatNewMsg
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
  | PanelReadyMsg
  | PanelNeedsClickMsg
  | OptionsOpenMsg
  | ReaderHelloMsg;

export function isRuntimeMessage(x: unknown): x is RuntimeMessage {
  return !!x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string';
}
