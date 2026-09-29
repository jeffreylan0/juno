/**
 * Typed messages between the content script, the background, the reader and
 * the panel. Every message carries a `type` and goes through `sendMessage`.
 *
 * Conversations do not travel over messages at all: the background writes
 * each tab's thread to `storage.session` (see threads.ts) and the panel
 * renders from storage change events. Messages here are commands only.
 */
import type { Rect, SelectionKind } from '@shared/payload';

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
  /** Text recovered from the DOM inside the selection. */
  text?: string;
  html?: string;
  label?: string;
  page: { url: string; title: string };
}

/** Content → background: the user cancelled. `closePanel` is set by the X. */
export interface SelectionCancelMsg {
  type: 'selection:cancel';
  /** The bar's X closes everything; Escape only cancels the selection. */
  closePanel?: boolean;
}

/**
 * Anything → background: the plan for a tab, or the most recent one when no
 * tab is given. Used by tests and diagnostics; the panel reads storage.
 */
export interface PlanGetMsg {
  type: 'plan:get';
  tabId?: number;
}

/** Panel → background: ask a question in a tab's conversation. */
export interface ChatSendMsg {
  type: 'chat:send';
  tabId: number;
  question: string;
}

/** Panel → background: ask the last failed question again. */
export interface ChatRetryMsg {
  type: 'chat:retry';
  tabId: number;
}

/** Panel → background: stop the answer streaming in a tab's conversation. */
export interface ChatStopMsg {
  type: 'chat:stop';
  tabId: number;
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
  | PlanGetMsg
  | ChatSendMsg
  | ChatStopMsg
  | ChatRetryMsg
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
