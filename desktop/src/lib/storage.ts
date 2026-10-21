/**
 * Settings, in storage.local, and `defineItem` for the app's other kept
 * values. Not the API keys: the native core keeps those where no page can
 * read them (vault.rs). Chats are not here: see lib/chats.ts (and
 * lib/images.ts for screenshots).
 */
import { ANSWER_COST, HOSTED_MODEL, vendorOf } from '@shared/models';
import { DEFAULT_MACROS, DEFAULT_PROMPT, DEFAULT_PROMPTS, type Macro } from '@shared/prompts';
import type { ModelRef, Provider } from '@shared/payload';
import type { Place } from '@/selection/bar';
import { DEFAULT_THEME, isThemeId } from './themes';

export type { Macro } from '@shared/prompts';

/**
 * What happens the moment a selection lands.
 * - `prefill`: the default prompt goes in the box, editable, and nothing is
 *   sent until the student asks. No surprise spend. The default.
 * - `auto`: the ask goes out immediately with the default prompt.
 */
export type SendBehavior = 'prefill' | 'auto';

export type Scheme = 'system' | 'light' | 'dark';
const SCHEMES: readonly Scheme[] = ['system', 'light', 'dark'];

/** How many saved chats this computer keeps; the oldest goes first. */
export const CHAT_LIMITS = [1, 5, 10, 25, 50, 100] as const;
const DEFAULT_CHAT_LIMIT = 10;

/** Bumped when a default changes in a way stored settings must pick up. */
export const SETTINGS_VERSION = 7;

/**
 * Where hosted plans are served from. A build setting, not a student one: it
 * comes from WXT_GATEWAY_URL at build time.
 */
export const GATEWAY_URL = (import.meta.env.WXT_GATEWAY_URL as string | undefined) ?? 'http://localhost:8787';

export interface Settings {
  version: number;
  /**
   * Who answers. `mock` (placeholder answers, for the eval and tests) means
   * no one yet in the app: asking waits for a choice.
   */
  provider: Provider;
  /** Preferred vendor for the router's model table. */
  vendor: 'anthropic' | 'openai';
  /** Explicit model override; empty means "let the router choose". */
  modelOverride: ModelRef | null;
  /** The model hosted answers use (a key of ANSWER_COST); null: the fast one. */
  hostedModel: string | null;
  /** What sits in the question box when a selection lands. Short, so it fits. */
  defaultPrompt: string;
  /** The buttons above the question box. Each fills the box and sends. */
  macros: Macro[];
  sendBehavior: SendBehavior;
  /**
   * After a box is drawn, keep it on screen with handles so an edge can be
   * nudged before anything is sent. Off (the default) sends on release.
   */
  adjustBox: boolean;
  /** Saved chats kept on this computer, one of CHAT_LIMITS. */
  chatLimit: number;
  /** Where the bar sits: the outer edge of a cell of a 3×3 grid of the screen. */
  barPlace: Place;
  /** Where the panel opens, the same way. */
  panelPlace: Place;
  /** The colour theme (lib/themes.ts). */
  theme: string;
  /** Light or dark, or as the system is (theme.ts). */
  scheme: Scheme;
  /** Install new versions by itself (core/updates.ts). */
  autoUpdate: boolean;
  /** Notices floating over the panel's chat (ui/Notices.tsx): no key, disconnected, an old chat deleted. */
  panelNotices: boolean;
  /**
   * Keep saved chats in the signed-in account's cloud (account/sync.ts), and
   * none on this computer once signed out. Only does anything for accounts
   * with cloud storage; on unless the student keeps them on this computer.
   */
  cloudSync: boolean;
  /** Every new chat starts temporary (the ghost on): not saved, not synced. */
  temporaryByDefault: boolean;
  localBaseUrl: string;
  localModel: string;
  /** The first-launch intro (settings/Intro.tsx) has played: it plays once. */
  introSeen: boolean;
  /** The first-run setup (settings/Setup.tsx) is behind the student. */
  setupDone: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  provider: 'mock',
  vendor: 'anthropic',
  modelOverride: null,
  hostedModel: null,
  defaultPrompt: DEFAULT_PROMPT,
  macros: DEFAULT_MACROS.map((m) => ({ ...m })),
  sendBehavior: 'prefill',
  adjustBox: false,
  chatLimit: DEFAULT_CHAT_LIMIT,
  barPlace: 'bottom-center',
  panelPlace: 'top-right',
  theme: DEFAULT_THEME,
  scheme: 'system',
  autoUpdate: true,
  panelNotices: true,
  cloudSync: true,
  temporaryByDefault: false,
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: 'qwen2.5vl:7b',
  introSeen: false,
  setupDone: false,
};

/** One value in storage.local, under `key`: `fallback` while there is none, and every change to it. */
export interface Item<T> {
  getValue(): Promise<T>;
  /** Null removes it. */
  setValue(value: T): Promise<void>;
  removeValue(): Promise<void>;
  /** Called on each change, from any window; returns the way to stop. */
  watch(cb: (value: T, old: T) => void): () => void;
}

export function defineItem<T>(key: string, fallback: T): Item<T> {
  const or = (v: unknown) => (v ?? fallback) as T;
  const remove = () => browser.storage.local.remove(key);
  return {
    getValue: async () => or((await browser.storage.local.get(key))[key]),
    setValue: (value) => (value == null ? remove() : browser.storage.local.set({ [key]: value })),
    removeValue: remove,
    watch(cb) {
      const heard = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => {
        const change = changes[key];
        if (change) cb(or(change.newValue), or(change.oldValue));
      };
      browser.storage.local.onChanged.addListener(heard);
      return () => browser.storage.local.onChanged.removeListener(heard);
    },
  };
}

export const settingsItem = defineItem<Settings>('settings', DEFAULT_SETTINGS);

/**
 * The size the student last gave the panel by hand (panel/fit.ts), which it
 * opens at from then on (core/main.ts), instead of growing with its chat.
 * Not a setting; settings can forget it.
 */
export interface PanelSize {
  width: number;
  height: number;
}
export const panelSizeItem = defineItem<PanelSize | null>('panelSize', null);

export async function getSettings(): Promise<Settings> {
  return migrateSettings(await settingsItem.getValue());
}

/**
 * Brings stored settings up to date. Settings once saved the whole object,
 * so a student who saved once has every old default pinned; a version bump is
 * how a changed default reaches them.
 *
 * v2: boxes send on release (adjusting is opt-in), and the per-mode prompts
 * (Explain/Hint/Check) became editable macros. A customised old prompt is
 * carried into the macro of the same name rather than lost.
 * v3: the question box starts empty (the macros do the asking), unless the
 * student had written their own default prompt; the hosted-plan URL stopped
 * being a setting.
 * v4: every selection is a screenshot, so "ask right away, screenshots only"
 * is simply "ask right away".
 * v5: an Answer macro joins the defaults, added to macros that lack one.
 * v6: placeholder answers are gone from the app; someone who had picked a
 * real AI has the first-run setup behind them.
 * v7: a new install keeps chats in the cloud (for accounts with cloud
 * storage) unless the student keeps them on this computer; an earlier
 * choice, which was off until turned on, is kept as it was.
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
  if ((s.version ?? 1) < 3) {
    if (s.defaultPrompt === undefined || s.defaultPrompt === V2_DEFAULT_PROMPT) merged.defaultPrompt = '';
  }
  if ((s.version ?? 1) < 5 && Array.isArray(s.macros)) {
    const answer = DEFAULT_MACROS.find((m) => m.id === 'answer')!;
    const has = (m: Macro) => m.id === answer.id || m.name.trim().toLowerCase() === 'answer' || m.prompt.trim() === answer.prompt;
    if (!s.macros.some(has)) merged.macros = [...s.macros, { ...answer }];
  }
  if ((s.version ?? 1) < 6) merged.setupDone = s.provider !== undefined && s.provider !== 'mock';
  if (merged.hostedModel !== null && !Object.hasOwn(ANSWER_COST, merged.hostedModel)) merged.hostedModel = null;
  merged.temporaryByDefault = merged.temporaryByDefault === true;
  // Set up before there was an intro: it is behind them too.
  if (s.introSeen === undefined) merged.introSeen = merged.setupDone;
  if ((merged.sendBehavior as string) === 'auto-box') merged.sendBehavior = 'auto';
  if (!isPlace(merged.barPlace)) merged.barPlace = DEFAULT_SETTINGS.barPlace;
  if (!isPlace(merged.panelPlace)) merged.panelPlace = DEFAULT_SETTINGS.panelPlace;
  if (!isThemeId(merged.theme)) merged.theme = DEFAULT_THEME;
  if (!SCHEMES.includes(merged.scheme)) merged.scheme = 'system';
  merged.autoUpdate = merged.autoUpdate !== false;
  merged.panelNotices = merged.panelNotices !== false;
  merged.macros = sanitizeMacros(merged.macros);
  if (!(CHAT_LIMITS as readonly number[]).includes(merged.chatLimit)) merged.chatLimit = DEFAULT_CHAT_LIMIT;
  merged.version = SETTINGS_VERSION;
  // Settings that no longer exist: the panel always opens with the first
  // selection; usage lines were never offered; blocked sites were for web
  // pages.
  const loose = merged as unknown as Record<string, unknown>;
  for (const gone of ['prompts', 'defaultMode', 'gatewayUrl', 'defaultSelectionKind', 'panelOpen', 'showUsage', 'blockedSites']) delete loose[gone];
  return merged;
}

const PLACES = new Set(['top', 'middle', 'bottom'].flatMap((row) => ['left', 'center', 'right'].map((col) => `${row}-${col}`)));
const isPlace = (v: unknown): v is Place => typeof v === 'string' && PLACES.has(v);

/** What the box used to be prefilled with; replaced only if left unchanged. */
const V2_DEFAULT_PROMPT = 'Explain this step by step.';

/**
 * Who answers, as one choice. Stored as three fields (provider, vendor and an
 * optional model) because the providers need them apart, but the student
 * only ever makes one decision, in the panel's model picker or in settings.
 */
export type AnswerChoice = 'none' | 'local' | `hosted:${string}` | `${'anthropic' | 'openai'}:${string}`;

/** The model hosted answers use: the one picked, or the fast one. */
export const hostedModelOf = (s: Pick<Settings, 'hostedModel'>): string => s.hostedModel ?? HOSTED_MODEL.anthropic;

export function answerChoiceOf(s: Pick<Settings, 'provider' | 'vendor' | 'modelOverride' | 'hostedModel'>): AnswerChoice {
  switch (s.provider) {
    case 'mock':
      return 'none';
    case 'local':
      return 'local';
    case 'gateway':
      return `hosted:${hostedModelOf(s)}`;
    case 'byok':
      return `${s.vendor}:${s.modelOverride?.vendor === s.vendor ? s.modelOverride.model : 'auto'}`;
  }
}

export function withAnswerChoice(s: Settings, choice: AnswerChoice): Settings {
  if (choice === 'none') return { ...s, provider: 'mock' };
  if (choice === 'local') return { ...s, provider: 'local' };
  if (choice.startsWith('hosted:')) {
    const model = choice.slice('hosted:'.length);
    return { ...s, provider: 'gateway', vendor: vendorOf(model), hostedModel: model === HOSTED_MODEL.anthropic ? null : model };
  }
  const [vendor, model] = choice.split(':') as ['anthropic' | 'openai', string];
  return { ...s, provider: 'byok', vendor, modelOverride: model === 'auto' || !model ? null : { vendor, model } };
}

/**
 * Whether a local model has been set up: picked, or its address or model
 * changed from the guess the app starts with (Ollama's usual one).
 */
export const localSetUp = (s: Pick<Settings, 'provider' | 'localBaseUrl' | 'localModel'>): boolean =>
  s.provider === 'local' || s.localBaseUrl !== DEFAULT_SETTINGS.localBaseUrl || s.localModel !== DEFAULT_SETTINGS.localModel;

/** The first thing to ask when nothing was typed: the default prompt, else the first macro. */
export function fallbackQuestion(s: Pick<Settings, 'defaultPrompt' | 'macros'>): string {
  return s.defaultPrompt.trim() || s.macros[0]?.prompt.trim() || 'Explain this.';
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

/** Whether a selection should be sent without waiting for the student. */
export function shouldAutoSend(settings: Settings): boolean {
  return settings.sendBehavior === 'auto';
}

