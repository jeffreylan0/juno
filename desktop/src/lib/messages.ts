/**
 * Typed messages between the app's pages: the bar (on the overlay), the core,
 * the panel and the settings. Every message carries a `type`; they travel
 * over the platform shim (platform/browser.ts).
 *
 * Chats do not travel over messages at all: the core writes them to storage
 * (chats.ts) and the panel renders from storage change events. Messages here
 * are commands only. The panel also holds a port open to the core
 * (PanelPortMsg), which is how the core knows it is there.
 */
import type { Point, Rect, SelectionKind } from '@shared/payload';

/** Bar → core, the instant a selection is committed and before any capture work: the panel opens at once. */
export interface SelectionCommittedMsg {
  type: 'selection:committed';
  kind: SelectionKind;
}

/**
 * Bar → core: the user finished a selection. The reply comes as
 * soon as the screenshot is taken, so the page can change again.
 */
export interface SelectionDoneMsg {
  type: 'selection:done';
  kind: SelectionKind;
  rect: Rect;
  devicePixelRatio: number;
  /** Freeform selections: the outline, in viewport CSS pixels. */
  path?: Point[];
  /** The viewport the rect is in, CSS pixels (the app crops a whole display with it). */
  viewport?: { width: number; height: number };
  page: { url: string; title: string };
}

/**
 * Bar → core: Escape stopped the selection being made. The reply
 * says whether that also hides the bar ({ end: true }: nothing had been
 * selected in this chat yet, so Escape meant "never mind").
 */
export interface SelectionCancelMsg {
  type: 'selection:cancel';
}

/**
 * Bar → core: ✕ on the bar, or Escape while it waits. Hides
 * the bar and the panel and finishes the chat; it stays in the menu.
 */
export interface ChatFinishMsg {
  type: 'chat:finish';
}

/**
 * Core → bar. `bar:show` brings the bar up selecting in `mode` (the shortcut
 * was pressed); `bar:hide` takes it away (the chat was finished from the
 * panel); `bar:ghost` says whether the next selection goes into a temporary
 * chat.
 */
export type BarControlMsg =
  /** `arm: false`: the bar comes up with nothing armed (before the app may see the screen). */
  | { type: 'bar:show'; mode: SelectionKind; ghost: boolean; arm?: boolean }
  | { type: 'bar:hide' }
  | { type: 'bar:ghost'; on: boolean };

/** Panel → core: ask a question in a chat. It carries every selection not yet asked about. */
export interface ChatSendMsg {
  type: 'chat:send';
  chatId: string;
  question: string;
}

/**
 * Panel → core: ask the latest question again, in place of it and its
 * answer: as it was (retry), or reworded (`question`: edit).
 */
export interface ChatRetryMsg {
  type: 'chat:retry';
  chatId: string;
  question?: string;
}

/** Panel → core: stop the answer streaming in a chat. */
export interface ChatStopMsg {
  type: 'chat:stop';
  chatId: string;
}

/**
 * Panel or bar → core: the ghost. On: the next selection goes into a
 * temporary chat. Off: leave the temporary chat (it is deleted). Replies with
 * the Current.
 */
export interface ChatTemporaryMsg {
  type: 'chat:temporary';
  on: boolean;
}

/** Panel → core: show a chat from the menu. */
export interface ChatOpenMsg {
  type: 'chat:open';
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

/** Settings → core: delete every saved chat and its screenshots. */
export interface ChatsDeleteAllMsg {
  type: 'chats:delete-all';
}

/** Panel → core: take back a selection no question has carried yet. */
export interface ChatDropSelectionMsg {
  type: 'chat:drop-selection';
  chatId: string;
  itemId: string;
}

/** Panel → core: check (or re-check) that the chosen AI is reachable. Replies with an AiStatus. */
export interface AiCheckMsg {
  type: 'ai:check';
  force?: boolean;
}

/**
 * Settings → core: check the stored API key by listing the vendor's models. It
 * costs nothing, proves the key works, and returns the models to pick from.
 */
export interface KeysTestMsg {
  type: 'keys:test';
  vendor: 'anthropic' | 'openai';
}

/**
 * Core → panel: a selection was just made and is on its way (the
 * screenshot and crop take a moment). The panel shows a placeholder for it,
 * so it never opens on nothing.
 */
export interface SelectionIncomingMsg {
  type: 'selection:incoming';
  kind: SelectionKind;
  /** When it was made (Date.now()): a selection in the chat from then on is it. */
  at: number;
}

/** The port the panel keeps open to the core, named this. */
export const PANEL_PORT = 'panel';

/**
 * Panel → core over the port: the panel is there. After the core reloads,
 * the panel says hello again and `claim`s the chat it is showing.
 */
export type PanelPortMsg = { type: 'hello'; claim?: { chatId: string; temporary: boolean } };

/** Copy chats to and from the cloud now (a panel or the settings page opened). */
export interface SyncNowMsg {
  type: 'sync:now';
}

/** Delete the signed-in account and its cloud copies; chats here stay. Replies { ok } or { error }. */
export interface AccountDeleteMsg {
  type: 'account:delete';
}

/** Bar → core: open the settings window. */
export interface OptionsOpenMsg {
  type: 'options:open';
}

export type RuntimeMessage =
  | SelectionCommittedMsg
  | SelectionDoneMsg
  | SelectionCancelMsg
  | ChatFinishMsg
  | BarControlMsg
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
  | SelectionIncomingMsg
  | OptionsOpenMsg
  | SyncNowMsg
  | AccountDeleteMsg;

export function isRuntimeMessage(x: unknown): x is RuntimeMessage {
  return !!x && typeof x === 'object' && typeof (x as { type?: unknown }).type === 'string';
}
