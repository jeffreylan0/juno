/**
 * Typed messages between the content script, the background, the popup and the
 * panel. Every message carries a `type`; request/response pairs go through
 * `sendMessage`, streams go through a runtime Port named PORT_ASK.
 */
import type { AskChunk, AskRequest, Mode, Plan, Rect, SelectionKind } from '@shared/payload';

export const PORT_ASK = 'selection-ai:ask';

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

/** Content → background: the user cancelled. */
export interface SelectionCancelMsg {
  type: 'selection:cancel';
}

/** Background → panel: a new plan is ready to show in the tray. */
export interface PlanReadyMsg {
  type: 'plan:ready';
  plan: Plan;
}

/** Panel or popup → background: fetch the current pending plan. */
export interface PlanGetMsg {
  type: 'plan:get';
}

/** Panel → background: change the mode of the pending plan. */
export interface PlanSetModeMsg {
  type: 'plan:setMode';
  mode: Mode;
}

/** Popup → background: open the answer panel from a real user gesture. */
export interface PanelOpenMsg {
  type: 'panel:open';
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

/** Panel → background over the ask port. */
export interface AskStartMsg {
  type: 'ask:start';
  request: AskRequest;
}
export interface AskAbortMsg {
  type: 'ask:abort';
}
export type AskPortIn = AskStartMsg | AskAbortMsg;
export type AskPortOut = AskChunk;

export type RuntimeMessage =
  | SelectionArmMsg
  | StartSelectionMsg
  | SelectionCommittedMsg
  | SelectionAbortMsg
  | SelectionDoneMsg
  | SelectionCancelMsg
  | PlanReadyMsg
  | PlanGetMsg
  | PlanSetModeMsg
  | PanelOpenMsg
  | PanelReadyMsg
  | PanelNeedsClickMsg
  | OptionsOpenMsg
  | ReaderHelloMsg;

export function isRuntimeMessage(x: unknown): x is RuntimeMessage {
  return !!x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string';
}

export function isAskPortIn(x: unknown): x is AskPortIn {
  if (!x || typeof x !== 'object') return false;
  const t = (x as { type?: unknown }).type;
  return t === 'ask:start' || t === 'ask:abort';
}
