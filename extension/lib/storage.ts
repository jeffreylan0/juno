/**
 * Settings and keys. Uses browser.storage.local via WXT's `storage` helper.
 * Conversations are not here: they live in storage.session (lib/threads.ts),
 * so no screenshot is ever written to disk.
 */
import { storage } from '#imports';
import { DEFAULT_MACROS, DEFAULT_PROMPT, DEFAULT_PROMPTS, type Macro } from '@shared/prompts';
import type { ModelRef, Provider, SelectionKind } from '@shared/payload';

export type { Macro } from '@shared/prompts';

/**
 * What happens the moment a selection lands.
 * - `prefill`: the default prompt goes in the box, editable, and nothing is
 *   sent until the student asks. No surprise spend. The default.
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

/** Bumped when a default changes in a way stored settings must pick up. */
export const SETTINGS_VERSION = 2;

export interface Settings {
  version: number;
  provider: Provider;
  /** Which selection mode the toolbar arms on click. */
  defaultSelectionKind: SelectionKind;
  /** Preferred vendor for the router's model table. */
  vendor: 'anthropic' | 'openai';
  /** Explicit model override; empty means "let the router choose". */
  modelOverride: ModelRef | null;
  /** What sits in the question box when a selection lands. Short, so it fits. */
  defaultPrompt: string;
  /** The buttons above the question box. Each fills the box and sends. */
  macros: Macro[];
  sendBehavior: SendBehavior;
  panelOpen: PanelOpen;
  /**
   * After a box is drawn, keep it on screen with handles so an edge can be
   * nudged before anything is sent. Off (the default) sends on release.
   */
  adjustBox: boolean;
  /**
   * Model, token count and estimated cost under each answer. Off for
   * students; a super-user setting once plans and pricing settle.
   */
  showUsage: boolean;
  /** Hostnames where the shortcut does nothing (exams, private portals). */
  blockedSites: string[];
  localBaseUrl: string;
  localModel: string;
  gatewayUrl: string;
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  provider: (import.meta.env.WXT_PROVIDER as Provider | undefined) ?? 'mock',
  defaultSelectionKind: 'box',
  vendor: 'anthropic',
  modelOverride: null,
  defaultPrompt: DEFAULT_PROMPT,
  macros: DEFAULT_MACROS.map((m) => ({ ...m })),
  sendBehavior: 'prefill',
  panelOpen: 'on-selection',
  adjustBox: false,
  showUsage: false,
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
  return migrateSettings(await settingsItem.getValue());
}

/**
 * Brings stored settings up to date. The options page saves the whole object,
 * so a student who saved once has every old default pinned; a version bump is
 * how a changed default reaches them.
 *
 * v2: boxes send on release (adjusting is opt-in), and the per-mode prompts
 * (Explain/Hint/Check) became editable macros. A customised old prompt is
 * carried into the macro of the same name rather than lost.
 */
export function migrateSettings(stored: unknown): Settings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<Settings> & {
    prompts?: Partial<Record<'explain' | 'hint' | 'check', string>>;
    defaultMode?: string;
  };
  const merged: Settings = { ...DEFAULT_SETTINGS, ...s };
  if ((s.version ?? 1) < 2) {
    merged.adjustBox = false;
    if (!s.macros) {
      merged.macros = DEFAULT_MACROS.map((m) => {
        const old = s.prompts?.[m.id as 'explain' | 'hint' | 'check'];
        const customised = old && old !== DEFAULT_PROMPTS[m.id as 'explain' | 'hint' | 'check'];
        return { ...m, prompt: customised ? old : m.prompt };
      });
    }
  }
  merged.macros = sanitizeMacros(merged.macros);
  merged.version = SETTINGS_VERSION;
  delete (merged as Partial<typeof s>).prompts;
  delete (merged as Partial<typeof s>).defaultMode;
  return merged;
}

/** Drops malformed entries and gives every macro a unique id. */
export function sanitizeMacros(macros: unknown): Macro[] {
  if (!Array.isArray(macros)) return DEFAULT_MACROS.map((m) => ({ ...m }));
  const seen = new Set<string>();
  const out: Macro[] = [];
  for (const m of macros) {
    if (!m || typeof m !== 'object') continue;
    const { id, name, prompt } = m as Partial<Macro>;
    if (typeof name !== 'string' || typeof prompt !== 'string') continue;
    let key = typeof id === 'string' && id ? id : slug(name);
    while (seen.has(key)) key = `${key}-2`;
    seen.add(key);
    out.push({ id: key, name, prompt });
  }
  return out;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'macro';
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
