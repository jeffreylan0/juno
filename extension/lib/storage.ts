/**
 * Settings and keys. Uses browser.storage.local via WXT's `storage` helper.
 * Text-only history lives here too (week 7); images are never persisted, which
 * keeps the store well under Safari's 5 MB cap.
 */
import { storage } from '#imports';
import { DEFAULT_PROMPTS } from '@shared/prompts';
import type { Mode, ModelRef, Provider, SelectionKind } from '@shared/payload';

/**
 * What happens the moment a selection lands.
 * - `prefill`: the mode's default prompt goes in the box, editable, and
 *   nothing is sent until the student asks. No surprise spend.
 * - `auto`: the ask goes out immediately with the default prompt.
 * - `auto-box`: box selections go out immediately; text and element wait.
 */
export type SendBehavior = 'prefill' | 'auto' | 'auto-box';

/**
 * When the answer panel opens.
 * - `on-selection`: the moment a selection is made. It never covers the page
 *   while you are still choosing what to select. The default.
 * - `on-click`: as soon as the toolbar icon is clicked, so it is already
 *   waiting — at the cost of taking up part of the page you are selecting on.
 */
export type PanelOpen = 'on-selection' | 'on-click';

export interface Settings {
  provider: Provider;
  defaultMode: Mode;
  /** Which selection mode the toolbar arms on click. */
  defaultSelectionKind: SelectionKind;
  /** Preferred vendor for the router's model table. */
  vendor: 'anthropic' | 'openai';
  /** Explicit model override; empty means "let the router choose". */
  modelOverride: ModelRef | null;
  /** The question that lands in the box for each mode. */
  prompts: Record<Mode, string>;
  sendBehavior: SendBehavior;
  panelOpen: PanelOpen;
  /**
   * After a box is drawn, keep it on screen with handles so an edge can be
   * nudged before anything is sent. Off sends on release, in one motion.
   */
  adjustBox: boolean;
  /** Hostnames where the shortcut does nothing (exams, private portals). */
  blockedSites: string[];
  localBaseUrl: string;
  localModel: string;
  gatewayUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: (import.meta.env.WXT_PROVIDER as Provider | undefined) ?? 'mock',
  defaultMode: 'explain',
  defaultSelectionKind: 'box',
  vendor: 'anthropic',
  modelOverride: null,
  prompts: { ...DEFAULT_PROMPTS },
  sendBehavior: 'prefill',
  panelOpen: 'on-selection',
  adjustBox: true,
  blockedSites: [],
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: 'qwen2.5vl:7b',
  gatewayUrl: (import.meta.env.WXT_GATEWAY_URL as string | undefined) ?? 'http://localhost:8787',
};

export interface Keys {
  anthropic: string;
  openai: string;
  /** Hosted-plan session token (Supabase), week 9. */
  session: string;
}

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

export const keysItem = storage.defineItem<Keys>('local:keys', {
  fallback: { anthropic: '', openai: '', session: '' },
});

export async function getSettings(): Promise<Settings> {
  const stored = await settingsItem.getValue();
  // Merge one level into `prompts` too, so a new mode added later still has text.
  return { ...DEFAULT_SETTINGS, ...stored, prompts: { ...DEFAULT_PROMPTS, ...stored?.prompts } };
}

export async function getKeys(): Promise<Keys> {
  return await keysItem.getValue();
}

/** Whether a selection of this kind should be sent without waiting for the student. */
export function shouldAutoSend(settings: Settings, kind: SelectionKind): boolean {
  if (settings.sendBehavior === 'auto') return true;
  if (settings.sendBehavior === 'auto-box') return kind === 'box';
  return false;
}
