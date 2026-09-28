/**
 * Typed messages between the content script, the background and the panel.
 * Every message carries a `type`; request/response pairs go through
 * `sendMessage`, streams go through a runtime Port named PORT_ASK.
 */
import type { AskChunk, AskRequest, Mode, Plan, Rect, SelectionKind } from '@shared/payload';

export const PORT_ASK = 'selection-ai:ask';

/** Background → content: start an interactive selection. */
export interface StartSelectionMsg {
  type: 'selection:start';
  kind: SelectionKind;
}

/** Content → background: the user finished a box or element selection. */
export interface SelectionDoneMsg {
  type: 'selection:done';
  kind: SelectionKind;
  rect: Rect;
  devicePixelRatio: number;
  /** Text recovered from the DOM inside the selection (text/element kinds). */
  text?: string;
  html?: string;
  label?: string;
  page: { url: string; title: string };
}

export interface SelectionCancelMsg {
  type: 'selection:cancel';
}

/** Background → panel: a new plan is ready to show in the tray. */
export interface PlanReadyMsg {
  type: 'plan:ready';
  plan: Plan;
}

/** Panel → background: fetch the current pending plan (panel may open late). */
export interface PlanGetMsg {
  type: 'plan:get';
}

/** Panel → background: change the mode of the pending plan. */
export interface PlanSetModeMsg {
  type: 'plan:setMode';
  mode: Mode;
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
  | StartSelectionMsg
  | SelectionDoneMsg
  | SelectionCancelMsg
  | PlanReadyMsg
  | PlanGetMsg
  | PlanSetModeMsg;

export function isRuntimeMessage(x: unknown): x is RuntimeMessage {
  return !!x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string';
}

export function isAskPortIn(x: unknown): x is AskPortIn {
  if (!x || typeof x !== 'object') return false;
  const t = (x as { type?: unknown }).type;
  return t === 'ask:start' || t === 'ask:abort';
}
